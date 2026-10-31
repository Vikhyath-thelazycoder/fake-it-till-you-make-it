-- Fake It: six tables and nothing else. Every table is closed to browsers (RLS with
-- no policies); only the Express backend, using the service role, reads and writes.

create table rounds (
  number int primary key check (number between 1 and 4),
  name text not null,
  time_limit_seconds int not null check (time_limit_seconds > 0)
);

insert into rounds (number, name, time_limit_seconds) values
  (1, 'Image Guess', 20),
  (2, 'Video Guess', 20),
  (3, 'Text Detective', 20),
  (4, 'The Fake Vault', 25);

create table questions (
  id uuid primary key default gen_random_uuid(),
  round_number int not null references rounds (number),
  position int not null,
  title text,
  hint text,
  prompt text not null,
  body text,
  options jsonb not null,
  correct_option text,
  created_at timestamptz not null default now()
);
create index questions_round_position on questions (round_number, position);

create table games (
  id uuid primary key default gen_random_uuid(),
  is_active boolean not null default true,
  -- Goes up on every admin action; phones use it to tell that something changed.
  version bigint not null default 1,
  results_published_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index one_active_game on games (is_active) where is_active;

create table teams (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games (id) on delete cascade,
  code text not null,
  -- Empty until the team joins with its printed code.
  name text,
  leader_name text,
  members jsonb,
  token_hash text unique,
  joined_at timestamptz,
  unique (game_id, code)
);
create unique index teams_unique_name on teams (game_id, lower(name)) where name is not null;

create table question_runs (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games (id) on delete cascade,
  question_id uuid not null references questions (id) on delete cascade,
  time_limit_seconds int not null,
  started_at timestamptz not null,
  deadline_at timestamptz not null,
  unique (game_id, question_id)
);
create index question_runs_latest on question_runs (game_id, started_at desc);

create table answers (
  run_id uuid not null references question_runs (id) on delete cascade,
  team_id uuid not null references teams (id) on delete cascade,
  choice text not null,
  elapsed_ms int not null,
  -- What this answer earns if its choice is the correct one. Whether it is correct is
  -- decided when scores are read, so changing an answer re-scores everyone.
  points_if_correct int not null check (points_if_correct between 1 and 5),
  primary key (run_id, team_id)
);
create index answers_team on answers (team_id);

alter table rounds enable row level security;
alter table questions enable row level security;
alter table games enable row level security;
alter table teams enable row level security;
alter table question_runs enable row level security;
alter table answers enable row level security;

insert into games default values;

-- The number on the countdown, then the points for it. A 20 s round has bands of 4 s
-- and a 25 s round has bands of 5 s, so both follow the one formula.
create function speed_points(p_elapsed_ms int, p_limit_seconds int)
returns int language sql immutable as $$
  select ceil(
    greatest(1, ceil((p_limit_seconds * 1000 - p_elapsed_ms) / 1000.0))
    / (p_limit_seconds / 5.0)
  )::int
$$;

-- One team's answer. The time is the database's clock when the answer arrives. It writes
-- only this team's own row, so teams never wait on each other.
create function submit_answer(p_token_hash text, p_run_id uuid, p_choice text)
returns text language plpgsql as $$
declare
  v_team teams;
  v_run question_runs;
  v_options jsonb;
  v_elapsed int;
  v_inserted int;
begin
  select * into v_team from teams where token_hash = p_token_hash;
  if not found then return 'bad_token'; end if;

  select r.* into v_run from question_runs r where r.id = p_run_id and r.game_id = v_team.game_id;
  if not found then return 'no_question'; end if;

  select options into v_options from questions where id = v_run.question_id;
  if not exists (select 1 from jsonb_array_elements(v_options) o where o ->> 'key' = p_choice) then
    return 'bad_choice';
  end if;

  v_elapsed := (extract(epoch from clock_timestamp() - v_run.started_at) * 1000)::int;
  -- One second of grace for an answer tapped just before zero and still on its way.
  if v_elapsed > v_run.time_limit_seconds * 1000 + 1000 then return 'late'; end if;

  insert into answers (run_id, team_id, choice, elapsed_ms, points_if_correct)
  values (p_run_id, v_team.id, p_choice, v_elapsed, speed_points(v_elapsed, v_run.time_limit_seconds))
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return case when v_inserted = 1 then 'locked' else 'duplicate' end;
exception
  -- The admin reset this question, or removed this team, at the very moment of the tap.
  when foreign_key_violation then return 'no_question';
end $$;

-- The newest question of the active game, without its answer.
create function live_state()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'gameId', g.id,
    'version', g.version,
    'published', g.results_published_at is not null,
    'run', (
      select jsonb_build_object(
        'id', r.id,
        'round', q.round_number,
        'roundName', rd.name,
        'number', (select count(*) from questions x
                   where x.round_number = q.round_number
                     and (x.position, x.created_at) <= (q.position, q.created_at)),
        'total', (select count(*) from questions x where x.round_number = q.round_number),
        'title', q.title,
        'hint', q.hint,
        'prompt', q.prompt,
        'body', q.body,
        'options', q.options,
        'startedAt', r.started_at,
        'deadlineAt', r.deadline_at,
        'limitSeconds', r.time_limit_seconds
      )
      from question_runs r
      join questions q on q.id = r.question_id
      join rounds rd on rd.number = q.round_number
      where r.game_id = g.id
      order by r.started_at desc
      limit 1
    )
  )
  from games g
  where g.is_active
$$;

-- Most points, then most correct answers, then least total time on correct answers.
create function leaderboard(p_game_id uuid)
returns table (
  team_id uuid,
  name text,
  leader_name text,
  members jsonb,
  points int,
  correct int,
  answered int,
  total_ms bigint,
  round_points jsonb,
  rank int
) language sql stable as $$
  with scored as (
    select
      t.id,
      q.round_number,
      a.elapsed_ms,
      a.choice is not null as answered,
      a.choice = q.correct_option as is_correct,
      a.points_if_correct
    from teams t
    left join answers a on a.team_id = t.id
    left join question_runs r on r.id = a.run_id
    left join questions q on q.id = r.question_id
    where t.game_id = p_game_id and t.name is not null
  ),
  totals as (
    select
      id,
      coalesce(sum(points_if_correct) filter (where is_correct), 0)::int as points,
      count(*) filter (where is_correct)::int as correct,
      count(*) filter (where answered)::int as answered,
      coalesce(sum(elapsed_ms) filter (where is_correct), 0)::bigint as total_ms,
      jsonb_build_object(
        '1', coalesce(sum(points_if_correct) filter (where is_correct and round_number = 1), 0),
        '2', coalesce(sum(points_if_correct) filter (where is_correct and round_number = 2), 0),
        '3', coalesce(sum(points_if_correct) filter (where is_correct and round_number = 3), 0),
        '4', coalesce(sum(points_if_correct) filter (where is_correct and round_number = 4), 0)
      ) as round_points
    from scored
    group by id
  )
  select
    t.id, t.name, t.leader_name, t.members,
    x.points, x.correct, x.answered, x.total_ms, x.round_points,
    (rank() over (order by x.points desc, x.correct desc, x.total_ms asc))::int
  from totals x
  join teams t on t.id = x.id
  order by 10, t.name
$$;

-- Start one question. Refused while another is still on the clock. The version change is
-- in the same transaction, so a phone told about it always finds the new question.
create function start_question(p_question_id uuid)
returns text language plpgsql as $$
declare
  v_game_id uuid;
  v_limit int;
begin
  -- The row lock serialises admin actions only; players never take it.
  select id into v_game_id from games where is_active for update;

  if exists (select 1 from question_runs where game_id = v_game_id and deadline_at > now()) then
    return 'busy';
  end if;
  if exists (select 1 from question_runs where game_id = v_game_id and question_id = p_question_id) then
    return 'already_played';
  end if;

  select rd.time_limit_seconds into v_limit
  from questions q join rounds rd on rd.number = q.round_number
  where q.id = p_question_id;
  if not found then return 'not_found'; end if;

  insert into question_runs (game_id, question_id, time_limit_seconds, started_at, deadline_at)
  values (v_game_id, p_question_id, v_limit, clock_timestamp(), clock_timestamp() + make_interval(secs => v_limit));

  update games set version = version + 1 where id = v_game_id;
  return 'started';
end $$;

-- Take a question back, with its answers, so it can be started again.
create function reset_question(p_question_id uuid)
returns void language plpgsql as $$
declare
  v_game_id uuid;
begin
  select id into v_game_id from games where is_active for update;
  delete from question_runs where game_id = v_game_id and question_id = p_question_id;
  update games set version = version + 1 where id = v_game_id;
end $$;

create function new_game()
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  perform 1 from games where is_active for update;
  update games set is_active = false where is_active;
  insert into games default values returning id into v_id;
  return v_id;
end $$;

create function set_published(p_published boolean)
returns void language sql as $$
  update games
  set results_published_at = case when p_published then now() end, version = version + 1
  where is_active
$$;

revoke all on function set_published(boolean) from public, anon, authenticated;
grant execute on function set_published(boolean) to service_role;
revoke all on function speed_points(int, int) from public, anon, authenticated;
revoke all on function submit_answer(text, uuid, text) from public, anon, authenticated;
revoke all on function live_state() from public, anon, authenticated;
revoke all on function leaderboard(uuid) from public, anon, authenticated;
revoke all on function start_question(uuid) from public, anon, authenticated;
revoke all on function reset_question(uuid) from public, anon, authenticated;
revoke all on function new_game() from public, anon, authenticated;
grant execute on function speed_points(int, int) to service_role;
grant execute on function submit_answer(text, uuid, text) to service_role;
grant execute on function live_state() to service_role;
grant execute on function leaderboard(uuid) to service_role;
grant execute on function start_question(uuid) to service_role;
grant execute on function reset_question(uuid) to service_role;
grant execute on function new_game() to service_role;
