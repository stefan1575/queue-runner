"""The queue runner's dashboard: its own small process, apart from the runner and from T3.

It shares two files with the runner and nothing else: `snapshot.json` (the runner writes it, the
page reads it) and `control.json` (the page writes it, the runner reads it).
"""
