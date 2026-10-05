"""
The suite never calls Google.

app.py builds its Gemma advisor from the environment and ml/.env at import,
and a developer's ml/.env holds a real key. The real environment wins over the
file (gemma.GemmaSettings.from_env), so switching Gemma off here, before any
test module imports the app, keeps every test offline and off the quota. The
Gemma tests build their own advisors around a fake transport.
"""

import os

os.environ["GEMMA_ENABLED"] = "0"
