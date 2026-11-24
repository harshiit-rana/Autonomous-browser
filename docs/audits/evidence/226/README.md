# Evidence for #226 (RUN-04): mission lifecycle in the running app

Produced with `scripts/dev/drive_run04.mjs` (recipe: `docs/dev/RUN_RECIPE.md`), Windows 11, Electron 33, the built app
(`npm run build`), real UI (omnibar `/do`, plan preview, question card, Pause/Takeover/Cancel buttons), real process kill.
The model is the **scripted e2e provider** (`AEGIS_E2E_MODEL_MODE=scripted`, test-only; scripts are `actor_script_*.json`):
it shows lifecycle behaviour, not answer quality. The shop is `tests/helpers/fixture_shop.ts` (one side effect, `POST /order`,
with an oracle at `GET /orders`).

| File | What it shows |
|---|---|
| `run_full_A_B_output.txt` | Launch A (approval card -> `waiting_approval`; Pause/Resume/Takeover/Hand Back labels follow the real state; `MISSION_ACTIVE` toast; process tree killed after the order) and Launch B (relaunch -> "Resume interrupted mission" banner -> resume -> completed; orders still 1). All A and B checks PASS. The run's last launch (C) was cut off by a hung `chrome.click` in the driver, which is why C was re-run alone: |
| `run_only_C_output.txt` | Launch C run alone (`--only-c`): Cancel during a 5 s tool -> cancelled in 52 ms and a new mission starts; renderer crash (CDP `Page.crash`) -> banner Reload page / Skip, state `paused(tab_crashed)`, Reload -> `running(crash_reload)` -> completed. 9/10 PASS; the single FAIL is the driver's own last check (a `TypeError` on the A/B app handles that do not exist with `--only-c`, fixed afterwards in the script); the logs of all three launches contain no `Unhandled`/`FATAL` (grep count 0). |
| `status_events_A.json` | `mission:status` events of the mission in Launch A: `seq` 1..8, reasons `mission_started, loop_started, question_asked, question_answered, user_pause, user_resume, user_takeover, user_handback`. |
| `status_events_C_crash.json` | Crash mission: `planning, running, paused(tab_crashed), running(crash_reload), completed`. |
| `checkpoint_at_kill.json` | The checkpoint file as it was at the kill (in the app data dir): the `click` on "Place order" is `done`, `sideEffect: true`. |
| `feed_B.json` | Activity feed of the resumed mission. |
| `os_01..08_*.png` | OS-level window captures (the real window including the native page): approval card, paused, takeover, toast, resume banner, resumed run completed, crash banner, after reload. |
| `electron_A/B/C.log`, `actor_script_*.json`, `earlier_cards_A.json` | Raw logs, the model scripts, and the cards the driver answered before the financial one (none were needed). |

NOT verified here: a live model; the per-provider cancel (done in `tests/test_mission_abort.ts` against local servers, not in the app);
swarm cancel and swarm resume (not implemented, see `docs/limitations.md`); macOS/Linux (this run is Windows only, CI runs the Electron suites on Linux).
