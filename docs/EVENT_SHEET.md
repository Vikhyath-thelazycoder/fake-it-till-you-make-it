# Event sheet

For whoever runs Fake It on the day.

## Before the crews arrive
1. Open the admin panel at `/admin` and keep one admin tab open, not several.
2. **Questions & answers tab:** check no question says "No answer yet". To fill a round, paste its answers in order.
3. **Teams tab:** make one code per team, print the player cards, hand them out.
4. Open the Supabase dashboard in another tab: **Reports → Database** and **Logs**.
5. Open `/results` on the projector laptop, ready for the end. Keep your PPT on the main screen until then.

## During the game
1. Show the slide.
2. On **Run game**, press **Start**. The phones get the question and the clock starts.
3. Watch "Answered". At zero the question disappears from every phone.
4. Next slide, next Start. Nothing runs until you press Start, so you can wait as long as you like between questions.

Keep one person on the Supabase tab:

| What you see | What it means | What to do |
|---|---|---|
| CPU or memory staying near the top | The database is struggling | Finish the current question and wait before starting the next |
| Many red 5xx lines in the logs | Requests are failing | Follow the steps below |
| Phones showing "Reconnecting…" | Phones can't reach the server | Follow the steps below if it's more than a few phones |

## If it slows down or crashes
1. Don't press Start. Between questions nothing is at stake.
2. Tell the crews: "Stay where you are. Don't refresh your phones."
3. Wait until the logs are clean. Phones retry on their own.
4. If a question was running when it went wrong, press **Reset** on it, then **Start** to play it again. Reset deletes every team's answer to that question, so everyone gets a fair second try.

## A crew has a problem
| Problem | Fix |
|---|---|
| Phone died or was lost | **Phone changed? Log back in** with the same secret code and leader name. The old phone stops working |
| Lost the player card | The code is on the Teams tab |
| Joined too late | They can join at any time, but questions already played count as 0 |
| A question or answer was wrong | Change the answer on the Questions tab. Everyone is re-scored at once |

## Winners
1. **Results tab:** check the ranking. Most points wins, then most correct answers, then least total time on correct answers.
2. Press **Publish results**. The results page and all phones update.
3. **New game** starts over with no teams. Do this only after the winners are announced.
