# Entropy

Entropy is a personal AI workspace that should move alongside Kars: a familiar place to think, plan, create, and eventually delegate work to a team of specialized agents.

The product vision and initial principles are in [the project charter](docs/CHARTER.md).

The proposed first release is described in [the MVP brief](docs/MVP.md).

Development conventions are in [AGENTS.md](AGENTS.md); Kars's project-linked learning plan is in [LEARNING.md](LEARNING.md).

## Run locally

Requires Python 3.10 or newer. Install dependencies and apply the database schema first; see [local setup](docs/SETUP.md). From the project root, run:

```powershell
python app.py
```

Then open <http://127.0.0.1:8765>. The default is a clearly labeled local demo provider, so it does not make paid model API calls. To configure GPT-6.1 Sol or PostgreSQL, see [the local setup guide](docs/SETUP.md). Conversation and task data are stored in the configured local database. PostgreSQL is selected with `ENTROPY_DATABASE_URL`; the ignored SQLite file remains available for isolated tests.
