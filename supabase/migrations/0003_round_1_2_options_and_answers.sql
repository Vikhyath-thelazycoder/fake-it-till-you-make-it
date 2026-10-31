-- Rounds 1 and 2 get four options, and the user's answers. Only AI and Real are ever correct.
update questions
set options = '[{"key":"AI","label":"AI-generated"},{"key":"REAL","label":"Real"},{"key":"UNKNOWN","label":"Unknown"},{"key":"EDITED","label":"Real, but edited"}]'::jsonb
where round_number in (1, 2);

update questions q
set correct_option = a.answer
from unnest(array[
  'AI','REAL','REAL','AI','AI','AI','REAL','REAL','REAL','REAL',
  'AI','AI','REAL','AI','REAL','AI','AI','REAL','REAL','AI'
]) with ordinality as a(answer, position)
where q.round_number = 1 and q.position = a.position;

update questions q
set correct_option = a.answer
from unnest(array['AI','REAL','REAL','AI','AI','AI','REAL','AI','AI','REAL']) with ordinality as a(answer, position)
where q.round_number = 2 and q.position = a.position;
