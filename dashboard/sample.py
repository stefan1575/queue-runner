"""Sample snapshots: the file the runner will publish, in each state the page has to show.

`build(name)` returns a whole `snapshot.json` (version 1) with its times set around now, so the
page can be judged without a runner. The shape here is the contract the runner's side is built
to. It also plays the runner reading `control.json` (a few seconds after it's written), so the
stop buttons can be tried; that part is the sample's only pretence.

Every time is an ISO string with its UTC offset; the page does the formatting.
"""
from __future__ import annotations

from datetime import datetime, timedelta

LD, QR, GB = "leads-dashboard", "queue-runner", "game-backdrop"
GH = {LD: "https://github.com/RoyalBullyAgency-RBA/leads-dashboard", QR: "https://github.com/stefan1575/queue-runner",
      GB: "https://github.com/stefan1575/game-backdrop"}
# A made-up favicon for leads-dashboard, so the sample shows both marks: a favicon, and (queue-runner,
# with none) the first two letters. The runner reads the real one from the repo (queue_runner/favicon.py).
LD_ICON = ("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+"
           "PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNyIgZmlsbD0iIzI1NjNlYiIvPjxwYXRoIGQ9Ik05IDIzVjlNOSAyM2g4IiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjMiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgZmlsbD0ibm9uZSIvPjxjaXJjbGUgY3g9IjIyIiBjeT0iMjAiIHI9IjMuNSIgZmlsbD0id2hpdGUiLz48L3N2Zz4=")
T3 = "https://app.t3.codes/threads/264b77bb-5ec7-4453-8ee5-7d0162886008/mcp%3A"

STATES = {
    "busy": "Three asks, both lanes working",
    "clear": "Inbox empty",
    "many": "Six asks",
    "reserve": "Claude waits: the rest of the week is kept for you",
    "limit": "Claude hit its session limit in the middle of a build",
    "github-down": "GitHub can't be read",
    "no-interrupt": "T3 refuses the interrupt, so Stop now is off for Claude",
    "dead": "The runner stopped writing 42 minutes ago",
    "repo-stopped": "leads-dashboard is stopped: its running jobs finish, then only queue-runner is worked on",
    "side-by-side": "Claude runs a job in each repo at once",
    "usage-stale": "Claude's usage hasn't been read for 40 minutes: every call answered 429",
    "reconnecting": "The PC woke 3 minutes ago: GitHub, Claude and ChatGPT haven't answered yet, so each is reconnecting",
    "inbox-unread": "The runner just started: the Inbox hasn't been read yet (asks null)",
    "stale": "Two threads waiting on you went cold: their Inbox items open fresh ones",
    "asked-again": "Claude's run on your answer asked again between two passes: the next job waits for a fresh usage reading",
}
DEFAULT = "busy"
# Takes of the page before this one, kept while its look is being agreed: `serve.py` serves the
# ones in `dashboard/earlier/` on the sample addresses, and the sidebar's sample menu links them.
EARLIER = [
    {"href": "/earlier/take-24.html", "label": "Take 24", "note": "The Queue as settled (#30), the Overview still take 9's three cards"},
    {"href": "/earlier/take-11.html", "label": "Take 11", "note": "The Queue as #107 and #109 decide it: repo by repo, side by side, one numbered list"},
    {"href": "/earlier/take-10.html", "label": "Take 10", "note": "The Queue as three variants on two repos: features first, the page you land on, tracks"},
    {"href": "/earlier/take-9.html", "label": "Take 9", "note": "The Overview as three cards, the Queue still the old work list and pyramid"},
    {"href": "/earlier/take-8.html", "label": "Take 8", "note": "The Inbox as agreed, the Overview still the two lanes"},
    {"href": "/earlier/take-7.html", "label": "Take 7", "note": "Briefing layouts A, B and C, the rows before T3's shape"},
    {"href": "/earlier/take-6.html", "label": "Take 6", "note": "The Inbox with icons, read, snooze and three briefing layouts, 1440px wide"},
    {"href": "/earlier/take-5.html", "label": "Take 5", "note": "The Inbox as its own page, before Stefan's notes on it"},
    {"href": "/earlier/take-4.html", "label": "Take 4", "note": "One page: Needs you as a box on top, the lanes, then the work"},
    {"href": "/earlier/take-3.html", "label": "Take 3", "note": "Lanes on top, a tab per ask, status first on the right"},
    {"href": "/earlier/take-2.html", "label": "Take 2", "note": "The asks listed beside the open one, lanes below, health in the sidebar"},
    {"href": "/earlier/take-1.html", "label": "Take 1", "note": "One page, no sidebar, the asks as bright slips"},
    {"href": "http://localhost:5288/", "label": "Prototype round 4", "note": "The React prototype, while its dev server runs"},
]
ACK_SECONDS = 3   # how long the pretend runner takes to read control.json
WAITS_FOR_REVIEW = "Waiting for review"   # a PR's status while it's in the reviewing lane's queue


def build(name: str = DEFAULT, base: datetime | None = None, control: dict | None = None,
          now: datetime | None = None) -> dict:
    """One sample snapshot. `base` is when the sample's story is told from (the server's start),
    so elapsed times grow while the page stays open."""
    if name not in STATES:
        raise ValueError(f"no sample state {name!r}")
    now = now or datetime.now().astimezone()
    base = base or now

    def ago(minutes: float) -> str:
        return (base - timedelta(minutes=minutes)).isoformat(timespec="seconds")

    def ahead(minutes: float) -> str:
        return (base + timedelta(minutes=minutes)).isoformat(timespec="seconds")

    snap = {
        "version": 1,
        "written_at": now.isoformat(timespec="seconds"),
        "write_every": 30,   # seconds: the longest a running runner goes between writes
        "control_read_at": None,
        "runner": {"pid": 18244, "started_at": ago(399), "commit": "66a5ea1"},
        "start_hint": "Double-click Queue runner.lnk in ~/.queue-runner, or run pythonw -m queue_runner in the repo.",
        "sources": [
            # Only what the runner depends on, the real snapshot's `SOURCES` (ticket 43). `short` is
            # the name beside its dot; `group` sorts them on the page: "provider", "local" (on
            # this PC) or "external". `retrying`: since when its calls have failed, while that's
            # too short to be red (`usage.SHOW_AFTER`): the page says it's reconnecting
            {"id": "github", "group": "external", "name": "GitHub", "short": "GitHub", "ok": True, "note": "gh as stefan1575", "checked_at": ago(1), "retrying": None},
            {"id": "t3", "group": "local", "name": "T3 Code", "short": "T3 Code", "ok": True, "note": "server up", "checked_at": ago(1), "retrying": None},
            {"id": "claude_usage", "group": "provider", "name": "Claude usage", "short": "Claude", "ok": True, "note": "read", "checked_at": ago(1), "retrying": None},
            {"id": "sol_usage", "group": "provider", "name": "ChatGPT usage", "short": "ChatGPT", "ok": True, "note": "read", "checked_at": ago(9), "retrying": None},
        ],
        # `stopped` (ticket 37): when Stefan stopped the repo (`at`), or null. A stopped repo
        # gets nothing from either lane; its asks stay in the Inbox.
        "repos": [
            # `doing`: the Claude job running in it (as a lane's `job`), and `wait`: why none
            # starts in it now (#50; both filled in by `_doing`, below). `icon`: its favicon as a
            # data: URL, or null (the page draws its first two letters).
            {"name": LD, "github": GH[LD], "icon": LD_ICON, "merge": "stefan", "stopped": None},
            {"name": QR, "github": GH[QR], "icon": None, "merge": "runner", "stopped": None},
            {"name": GB, "github": GH[GB], "icon": None, "merge": "stefan", "stopped": None},
        ],
        # An ask is written to be picked up cold, a week later. `kind` is why it came to Stefan:
        # `stuck` (the runner tried and couldn't get it through), `decision` (a product decision
        # is his), `merge` (ready, his to merge) or `broken` (something failed). `situation` says
        # it in a sentence, `about` what the work is, `because` the specifics, `timeline` what has
        # happened, in order, each step with its time and a whole sentence (`_TIMELINES`, added
        # below; `story` is the same in fragments, read by the earlier takes only); then `question`, `options` and where it's answered (`go`, whose
        # `where` is "t3" or "github": it picks the mark on the button).
        # `why` is read by the earlier takes only, and goes when they do.
        # `decide` (ticket 35) is null for an ask that can't be decided in a T3 thread, else where
        # that stands: `state` "offered" (the page's Decide in T3 asks the runner to open one),
        # "asked" (the runner read the request; `note` says when it starts) or "open" (`go` is
        # the thread then, and `also` the other place to answer it, its needs-info issue), or
        # "stale" (issue #72: the thread went cold and was settled; `label` is the button that
        # asks for a fresh one, `note` why). A thread waiting for his answer has a `decide` only
        # once it's stale, or once a fresh thread to answer in is open.
        "asks": [
            {
                "id": "ask-152", "kind": "stuck", "repo": LD, "ref": "PR #152", "pr": 152,
                "subject": "Ring-to number per Client", "since": ago(128),
                "situation": "Three fix rounds haven't got this PR past review.",
                "about": "Each Client gets their own ring-to number: the phone that rings when a lead calls their tracking number.",
                "because": "The check still reads the old owner when a Client changes owner during a call. "
                           "That kind of problem was fixed in review 1 and came back in review 3.",
                "story": ["Wed: built, PR #152 opened", "Review 1: two problems, fixed", "Review 2: one problem, fixed",
                          "Today: review 3 found the first kind again", "A decision thread recommends rework"],
                "question": "Rework the approach, patch this case too, or hold it?",
                "options": [
                    {"say": "rework", "means": "A fix round that reads the owner from the call's routing row", "recommended": True},
                    {"say": "fix on", "means": "A fix round that patches this case, same approach"},
                    {"say": "hold", "means": "Leave the PR until you release it"},
                ],
                "holds_up": ["#216 Ring-to audit page"],
                "go": {"label": "Decide in T3", "where": "t3", "url": T3 + "0481ebdf-41e8-4253-b3a1-3be2d40a80b2"},
                "decide": {"state": "open", "at": ago(20), "note": None},
                "also": {"label": "Open the needs-info issue", "where": "github", "url": GH[LD] + "/issues/219"},
                "why": [
                    "Review 3 raised I-4 again: the ring-to check reads the Client's owner from before the move.",
                    "The decision thread's approach note recommends rework: read the owner from the call's routing row, not from the Client.",
                ],
            },
            {
                "id": "ask-207", "kind": "merge", "repo": LD, "ref": "PR #207", "pr": 207,
                "subject": "A Client's Twilio number on their page", "since": ago(40),
                "situation": "This PR is reviewed clean and ready for you to merge.",
                "about": "A Client's page shows the Twilio tracking number assigned to them, once their Twilio account is verified.",
                "because": "Clean on a0d5f6f, checks passed, no conflict, nothing said since. In leads-dashboard the merge is yours.",
                "story": ["Thu: built, PR #207 opened", "Review 1: one problem, fixed", "Today: review 2 clean"],
                "question": "Merge it when you've looked. Its live steps follow your merge.",
                "holds_up": [],
                "go": {"label": "Open PR to merge", "where": "github", "url": GH[LD] + "/pull/207"},
                "why": ["Clean on a0d5f6f after review 2. Checks passed, no conflict, nothing said since."],
            },
            {
                "id": "ask-214", "kind": "decision", "repo": LD, "ref": "#214", "pr": None,
                "subject": "Client onboarding form", "since": ago(12),
                "situation": "The build stopped at a question the issue doesn't answer.",
                "about": "A form a new Client fills in after signing: business details, service areas and call hours.",
                "because": "Whether the form is required decides which fields the build makes mandatory. "
                           "A decision thread couldn't settle it from the issue.",
                "story": ["Today: the build started", "It stopped before writing the form's required fields"],
                "question": "Must every Client fill in the onboarding form before they go live?",
                "holds_up": ["#215 SEO questions on the form", "#223 Welcome email after the form"],
                "go": {"label": "Answer in T3", "where": "t3", "url": T3 + "0d6566e9-86a3-4e0f-a64a-e0443d93d0fe"},
                "why": [
                    "The build stopped before writing the form's required fields.",
                    "A decision thread couldn't answer it from the issue.",
                ],
            },
        ],
        # Asks Stefan has answered that the runner hasn't acted on yet: the same shape, with
        # `answered` (when, what he said, what the runner does with it). The Inbox keeps them
        # greyed under the open ones, so an answer that is still held can be told from one
        # that's handled. They aren't counted as waiting on him.
        "answered": [
            {
                "id": "ask-212", "kind": "decision", "repo": LD, "ref": "#212", "pr": None,
                "subject": "Archive view for old callers", "since": ago(70),
                "situation": "The build stopped at how old a caller must be to count as old.",
                "about": "A view of callers who haven't called for a while, kept out of the main callers list.",
                "because": "The issue says \"old callers\" without saying how old. A decision thread couldn't settle it.",
                "story": ["Today: the build started", "It stopped at the archive's cut-off", "You answered after 12 months"],
                "question": "After how long without a call does a caller move to the archive?",
                "options": [],
                "holds_up": [],
                "go": {"label": "Answer in T3", "where": "t3", "url": T3 + "130f3d30-2a6c-4260-9c8e-941810cb97e1"},
                "answered": {"at": ago(38), "said": "after 12 months",
                             "next": "The runner carries on with the build, using your answer."},
            },
            {
                "id": "ask-209", "kind": "stuck", "repo": LD, "ref": "PR #209", "pr": None,
                "subject": "Voicemail transcripts on the call page", "since": ago(26 * 60),
                "situation": "Review 3 was still blocking, so it came to you.",
                "about": "A call that went to voicemail shows its transcript on the call's page.",
                "because": "The transcript is fetched on every page load. Review 3 found a third place that does it.",
                "story": ["Fri: built, PR #209 opened", "Reviews 1 and 2: problems fixed", "Yesterday: review 3 still blocking",
                          "Today: you answered fix on"],
                "question": "Rework the approach, patch this case too, or hold it?",
                "options": [
                    {"say": "rework", "means": "One more fix round that reworks the approach, as the note and your reply say"},
                    {"say": "fix on", "means": "One more fix round on the open findings, the same approach", "recommended": True},
                    {"say": "hold", "means": "Leave the PR until you release it"},
                ],
                "holds_up": [],
                "go": {"label": "Open the needs-info issue", "where": "github", "url": GH[LD] + "/issues/221"},
                "answered": {"at": ago(7), "said": "fix on",
                             "next": "The runner reads your reply on its next pass and queues one more fix round."},
            },
        ],
        "lanes": [
            {
                # `provider` picks the mark: "claude" or "chatgpt"; any other gets none
                "id": "claude", "provider": "claude", "name": "Claude", "does": "builds and fixes", "model": "Opus 5.5",
                "state": "working",
                "job": {"kind": "build", "repo": LD, "ref": "#212", "title": "Archive view for old callers",
                        "started_at": ago(35), "sha": None, "pr": None,
                        "thread": T3 + "130f3d30-2a6c-4260-9c8e-941810cb97e1"},
                "next": "Fix round on PR #204",
                "wait": None,
                "stop_now": {"available": True, "note": None,
                             "effect": "Cuts the thread off. Its branch stays, and the job carries on later from where it stopped."},
            },
            {
                "id": "sol", "provider": "chatgpt", "name": "ChatGPT", "does": "reviews", "model": "GPT-6.1 Sol",
                "state": "working",
                "job": {"kind": "review", "repo": LD, "ref": "PR #210", "title": "Callers list: filter by tag",
                        "started_at": ago(12), "sha": "4be91c2", "pr": 210, "thread": None},
                "next": "Nothing else waits for review",
                "wait": None,
                "stop_now": {"available": True, "note": None,
                             "effect": "Cuts the review off. The PR is reviewed afresh later, on its head then."},
            },
        ],
        "usage": [
            # A model's own weekly window (Fable's here) is listed only when the account has one.
            # `resets`: the reset credits a plan has left (ticket 42), or None when it has none to give.
            # `next_read_at` (issue 66): when Claude's usage endpoint may be asked again (once every
            # 5 minutes), while that's ahead; None for a plan read whenever it's asked. `retrying`:
            # since when its reads have failed, while that isn't shown as an error.
            {"id": "claude", "provider": "claude", "name": "Claude", "plan": None, "read_at": ago(1), "error": None,
             "resets": {"available": 2}, "next_read_at": ahead(4), "retrying": None, "windows": [
                {"id": "five_hour", "label": "Session", "used": 38, "resets_at": ahead(60), "gates": True},
                {"id": "week", "label": "Weekly", "used": 46, "resets_at": ahead(60 * 49.7), "gates": True,
                 "reserve": 5, "reserve_opens_at": ahead(60 * 25.7)},
                {"id": "week_fable", "label": "Weekly, Fable", "used": 100, "resets_at": ahead(60 * 49.7),
                 "gates": False, "note": "The runner doesn't use Fable."},
            ]},
            {"id": "sol", "provider": "chatgpt", "name": "ChatGPT", "plan": None, "read_at": ago(9), "error": None,
             "resets": None, "next_read_at": None, "retrying": None, "windows": [
                {"id": "five_hour", "label": "Session", "used": 26, "resets_at": ahead(94), "gates": True},
                {"id": "week", "label": "Weekly", "used": 6, "resets_at": ahead(60 * 152.9), "gates": True},
            ]},
        ],
        # Refresh on the Usage card (ticket 42): the request the runner last read both plans for.
        "usage_refresh": None,
        "knob": {"paused": False, "reserve": 5},   # gate.json's reserve; paused: the Claude lane is stopped
        # What the gate expects a Claude job to take, per kind (the Usage page).
        "costs": [
            {"kind": "build", "label": "Build", "session": 60, "week": 15, "basis": "The cautious default, until 3 builds are recorded"},
            {"kind": "fix", "label": "Fix round", "session": 34, "week": 6, "basis": "The largest of the last 5"},
            {"kind": "decision", "label": "Decision", "session": 15, "week": 4, "basis": "The cautious default"},
            {"kind": "live", "label": "Live steps", "session": 20, "week": 5, "basis": "The cautious default"},
        ],
        # Which lane does each kind of job (Settings).
        "roles": [
            {"job": "Build", "what": "A new issue becomes a PR", "lane": "claude"},
            {"job": "Fix", "what": "Answers a blocking review, or merges main into a PR that conflicts", "lane": "claude"},
            {"job": "Decision", "what": "Decides a case the fixed flow doesn't cover", "lane": "claude"},
            {"job": "Live steps", "what": "After a merge, makes it live", "lane": "claude"},
            {"job": "Review", "what": "Reviews each PR head", "lane": "sol"},
        ],
        # PROTOTYPE (#30, take 11): efforts as a tree. A spec or a map, its `parent` the effort
        # it's a sub-issue of (null at a repo's top), and `blocked_by` the effort's own blockers,
        # which hold every ticket under it (#107). A ticket's effort is its `feature`.
        "efforts": _efforts(),
        # Each repo's Claude queue (#107), as the chooser takes it: what's running there, why
        # nothing starts if nothing does, and the jobs that go before any build (decisions, live
        # steps, fix rounds), each with the sentence that says why. The page adds the builds
        # from the effort order, since dragging changes it (#109).
        "repo_queues": _repo_queues(),
        # Blockers in a repository the runner doesn't serve: named, never built (#107).
        "outside": [
            {"key": "fluent-icons#3", "repo": "fluent-icons", "n": 3, "title": "Export the tray icons at 16 and 20 px",
             "url": "https://github.com/stefan1575/fluent-icons/issues/3"},
        ],
        # The old takes read `features`: the efforts that hold tickets (`_order`, below, puts them
        # in build order; `_tickets` gives each its tickets in the order they're built).
        "features": [],
        "issues": _issues(),
        "prs": _prs(ago),
    }
    snap["activity"] = _activity(snap["prs"], ago)
    held = {i["feature"] for i in snap["issues"]}
    snap["features"] = [{k: e[k] for k in ("id", "repo", "n", "title")} for e in snap["efforts"] if e["id"] in held]
    _vary(snap, name, ago, ahead)
    for ask in snap["asks"] + snap["answered"]:
        ask.setdefault("decide", None)
        ask.setdefault("also", None)
    for ask in snap["asks"] + snap["answered"]:
        ask["timeline"] = [{"at": ago(minutes), "text": text} for minutes, text in _TIMELINES[ask["id"]]]
        ask.update(read=False, snoozed_until=None)   # what Stefan did with it: control.json's `asks` (ticket 36)
    if name == "dead":
        snap["written_at"] = (now - timedelta(minutes=42)).isoformat(timespec="seconds")
    else:
        _obey(snap, control or {}, now)
    _doing(snap)
    _number(snap)
    _order(snap)
    _tickets(snap)
    _queue(snap)
    if name == "inbox-unread":   # before the Sol lane's first Inbox read (issue #92)
        snap["asks"] = snap["answered"] = None
    # The page lists them in the sidebar; the runner's file has no such key.
    snap["sample"] = {"state": name, "states": STATES, "earlier": EARLIER}
    return snap


DAY = 24 * 60
# What has happened to each ask, oldest first: minutes ago, and the step in a whole sentence.
_TIMELINES = {
    "ask-152": [
        (4 * DAY + 328, "Claude built it and opened PR #152, in 5 commits."),
        (4 * DAY + 300, "Review 1 found two problems: the number was saved without being normalised, and the owner check "
                        "read the Client from before a move. A fix round fixed both."),
        (4 * DAY + 249, "Review 2 found one problem: a migration added a required column with no default. A fix round fixed it."),
        (140, "Review 3 found the owner problem again, in a new place: when a Client is reassigned during a call."),
        (129, "A decision thread wrote an approach note. It recommends rework: read the owner from the call's routing row."),
        (128, "The runner stopped the PR and brought it to you."),
    ],
    "ask-207": [
        (3 * DAY + 610, "Claude built it and opened PR #207, in 4 commits."),
        (3 * DAY + 590, "Review 1 found one problem: the number showed before the Client's Twilio account was verified."),
        (3 * DAY + 570, "A fix round pushed the fix."),
        (48, "Review 2 came back clean, and the checks passed."),
        (40, "The runner marked it ready for you to merge."),
    ],
    "ask-214": [
        (30, "Claude started building #214."),
        (14, "The build stopped before writing the form's required fields: the issue doesn't say whether the form is required."),
        (12, "A decision thread couldn't settle it from the issue, so it came to you."),
    ],
    "ask-live": [
        (DAY + 130, "You merged PR #198."),
        (9, "The live steps deployed it and applied the first of its 2 migrations."),
        (6, "The second migration failed: column \"owner_id\" already exists. The live run stopped there and came to you."),
    ],
    "ask-qr4": [
        (70, "Claude built it and opened PR #4, in 2 commits."),
        (28, "Review 1 came back clean."),
        (5, "The tests timed out on Windows, in test_wake.py. They pass locally."),
        (3, "A decision thread couldn't tell a flake from a fault, so it came to you."),
    ],
    "ask-ops": [
        (9, "Claude started building #231."),
        (2, "The build stopped at the recipient list: the issue names the Client's owner in one place and everyone "
            "on the account in another."),
        (1, "A decision thread couldn't settle it from the issue, so it came to you."),
    ],
    "ask-212": [
        (80, "Claude started building #212."),
        (72, "The build stopped at the archive's cut-off: the issue says \"old callers\" without saying how old."),
        (70, "A decision thread couldn't settle it from the issue, so it came to you."),
        (38, "You answered: after 12 months."),
    ],
    "ask-209": [
        (3 * DAY, "Claude built it and opened PR #209."),
        (2 * DAY, "Reviews 1 and 2 found problems, and fix rounds fixed them."),
        (26 * 60 + 20, "Review 3 was still blocking: a third place fetches the transcript on every page load."),
        (26 * 60, "The runner stopped the PR and brought it to you, with an approach note."),
        (7, "You answered: fix on."),
    ],
}


def _efforts() -> list[dict]:
    def e(repo, n, title, kind, parent=None, blocked_by=()):
        return {"id": f"{repo}#{n}", "repo": repo, "n": n, "title": title, "kind": kind,
                "parent": parent and f"{repo}#{parent}", "blocked_by": [f"{repo}#{b}" for b in blocked_by]}
    return [
        # leads-dashboard: a map holding two specs, then two specs of their own, and a finished one
        e(LD, 140, "Client phone setup", "map"),
        e(LD, 149, "Ring-to numbers", "spec", parent=140),
        e(LD, 220, "Client onboarding", "spec", parent=140),
        e(LD, 225, "Analytics", "spec"),
        e(LD, 200, "Callers", "spec"),
        e(LD, 240, "Third-party export", "spec"),
        e(LD, 180, "Missed-call texts", "spec"),   # finished: every ticket is live
        # queue-runner: the efforts Stefan orders it by (2026-11-17), the rebuild among them
        e(QR, 120, "Queue page", "spec"),
        e(QR, 121, "Inbox", "spec"),
        e(QR, 122, "Usage", "spec"),
        e(QR, 125, "Settings", "spec"),
        e(QR, 68, "TypeScript rewrite", "spec", blocked_by=[30]),
        # game-backdrop: its spec, and a second effort held by a blocker of its own
        e(GB, 1, "Game Backdrop", "spec"),
        e(GB, 22, "Backdrop themes", "spec", blocked_by=[4]),
    ]


def _repo_queues() -> list[dict]:
    """The jobs that go before any build in each repo, as the chooser takes them (#107)."""
    def j(kind, ref, title, why):
        return {"kind": kind, "ref": ref, "title": title, "why": why}
    return [
        {"repo": LD, "jobs": [
            j("fix", "PR #204", "Unassigned: assign several at once",
              "A fix round comes before any build: open PRs finish first. Review 2 found one problem."),
        ], "starts": None},
        {"repo": QR, "jobs": [],
         "starts": "Starts when the gate lets a second job in: leads-dashboard waited longest, so it went first."},
        {"repo": GB, "jobs": [
            j("decision", "PR #14", "Live changes while a game runs",
              "A decision comes before any build: review 2 asked for a setting the spec doesn't name."),
        ], "starts": "Starts after queue-runner's: the gate admits the repo that waited longest first."},
    ]


def _issues() -> list[dict]:
    def i(repo, n, title, state, feature=None, pr=None, blocked_by=(), note=None, fix=None, filed=False):
        return {"repo": repo, "n": n, "title": title, "state": state, "feature": feature and f"{repo}#{feature}",
                "pr": pr, "blocked_by": [b if isinstance(b, str) else f"{repo}#{b}" for b in blocked_by],
                "note": note, "pick": None, "fix": fix, "runner_filed": filed,
                "about": ABOUT.get((repo, n))}
    # PROTOTYPE (#30, take 17): what a ticket is, in a line, as its issue's first sentence would
    # say it. Only leads-dashboard's are written; a ticket without one shows none.
    ABOUT = {
        (LD, 151): "Stores the phone that rings for each Client.",
        (LD, 191): "Shows the Client's Twilio tracking number on their page.",
        (LD, 150): "Each Client gets the phone that rings when a lead calls.",
        (LD, 216): "A page listing every ring-to change and who made it.",
        (LD, 233): "Brand registration so texts from Twilio numbers get delivered.",
        (LD, 235): "Sends texts to callers from the Client's ring-to number.",
        (LD, 214): "Business details, service areas and call hours, after signing.",
        (LD, 215): "Adds the SEO questions a Client answers during onboarding.",
        (LD, 223): "Emails the Client once their onboarding form is in.",
        (LD, 226): "Records every call as an event the reports can count.",
        (LD, 227): "Totals each day's call events per Client.",
        (LD, 228): "Charts of calls and leads over time.",
        (LD, 229): "Which sources the leads came from, per Client.",
        (LD, 230): "Downloads the analytics tables as CSV.",
        (LD, 196): "Every call records which lead source it came from.",
        (LD, 217): "Every call records how long it lasted.",
        (LD, 193): "Notes a rep writes about a caller, on the caller's page.",
        (LD, 205): "Narrows the callers list to one or more tags.",
        (LD, 212): "Callers quiet for 90 days move to an archive view.",
        (LD, 213): "Sorts the callers list by each caller's last call.",
        (LD, 218): "Downloads the calls list as a CSV file.",
        (LD, 181): "Texts the caller back when nobody picks up.",
        (LD, 183): "Each Client writes the text their callers get.",
        (LD, 185): "Stops texts to a caller who replies STOP.",
        (LD, 199): "Assigns several unassigned leads to a rep at once.",
        (LD, 211): "Checks each Client domain's DNS and email records.",
        (LD, 237): "The steps that make a merge live on Lovable Cloud.",
        (LD, 244): "Stores each Client's CRM export keys.",
        (LD, 241): "Sends each new lead to the Client's HubSpot.",
        (LD, 242): "Maps the dashboard's fields to each Client's CRM fields.",
        (LD, 243): "Syncs every night and logs what it retried.",
        (LD, 245): "Decide which CRMs to support after HubSpot.",
    }
    # `state` is where a ticket stands. Done means live: `done` once its live steps ran, `merged`
    # while it's merged and they haven't. Then `review` and `fixing` (in a PR), `building`, `you`
    # (an ask in the Inbox), `ready-for-human` (Stefan builds it), `needs-triage` (he decides what
    # it becomes; no label counts as this), `fixing-itself` (#108: the runner got stuck on it and
    # filed `fix`, which it builds first), `ready` (ready-for-agent, nothing open in its way) and
    # `blocked`. A blocker in another repo is named `repo#n`.
    return [
        # leads-dashboard
        i(LD, 151, "Save a Client's ring-to number", "done", 149),
        i(LD, 188, "Ring-to number in the call log", "merged", 149, pr=203,
          note="Its live steps wait for the review of PR #210"),
        i(LD, 191, "A Client's Twilio number on their page", "you", 149, pr=207, note="PR #207 is ready for you to merge"),
        i(LD, 150, "Ring-to number per Client", "you", 149, pr=152, note="PR #152 waits for your decision"),
        i(LD, 216, "Ring-to audit page", "blocked", 149, blocked_by=[150]),
        i(LD, 233, "Register the A2P brand in Twilio", "ready-for-human", 149),
        i(LD, 235, "Text callers from the ring-to number", "blocked", 149, blocked_by=[233]),
        i(LD, 214, "Client onboarding form", "you", 220, note="Its build waits for your answer"),
        i(LD, 215, "SEO questions on the form", "blocked", 220, blocked_by=[214]),
        i(LD, 223, "Welcome email after the form", "blocked", 220, blocked_by=[214]),
        i(LD, 226, "Store call events", "ready", 225),
        i(LD, 227, "Daily rollup of events", "blocked", 225, blocked_by=[226]),
        i(LD, 228, "Charts page", "blocked", 225, blocked_by=[227]),
        i(LD, 229, "Lead source report", "blocked", 225, blocked_by=[227, 196]),
        i(LD, 230, "Export analytics as CSV", "blocked", 225, blocked_by=[228, 218]),
        i(LD, 196, "Lead source on every call", "done", 225),
        i(LD, 217, "Call length on every call", "review", 225, pr=232, note="PR #232 waits for its review, after PR #210"),
        i(LD, 193, "Caller notes on the caller's page", "done", 200),
        i(LD, 205, "Callers list: filter by tag", "review", 200, pr=210, note="Sol is reviewing PR #210"),
        i(LD, 212, "Archive view for old callers", "building", 200, note="Claude is building it"),
        i(LD, 213, "Callers list: sort by last call", "ready", 200),
        i(LD, 218, "Export calls as CSV", "needs-triage", 200),
        i(LD, 181, "Text the caller back when a call is missed", "done", 180),
        i(LD, 183, "A Client's own wording for the text", "done", 180),
        i(LD, 185, "Stop texting a caller who opts out", "done", 180),
        i(LD, 199, "Unassigned: assign several at once", "fixing", pr=204, note="Its fix round on PR #204 is next"),
        i(LD, 211, "Domain health check", "fixing-itself", pr=224, fix=f"{QR}#112",
          note="PR #224's two reviews failed on one head"),
        i(LD, 237, "Write the live-steps doc for Lovable Cloud", "ready"),
        i(LD, 244, "Store each Client's export keys", "done", 240),
        i(LD, 241, "Send new leads to HubSpot", "ready", 240),
        i(LD, 242, "Field mapping per Client", "blocked", 240, blocked_by=[241]),
        i(LD, 243, "Nightly sync with a retry log", "blocked", 240, blocked_by=[242]),
        i(LD, 245, "Which CRMs besides HubSpot?", "needs-triage", 240),
        # queue-runner
        i(QR, 30, "Prototype the Queue page", "ready-for-human", 120),
        i(QR, 107, "The queue says what each repo takes up next, and why", "needs-triage", 120, blocked_by=[30]),
        i(QR, 109, "Order a repo's efforts by dragging them", "needs-triage", 120, blocked_by=[107]),
        i(QR, 34, "Stop now through T3's interrupt", "blocked", 120, blocked_by=[30]),
        i(QR, 72, "A stale ask reopens in a fresh thread", "done", 121),
        i(QR, 92, "Ask marks survive a restart", "review", 121, pr=104, note="PR #104 waits for its review"),
        i(QR, 131, "Snooze an ask until a time you pick", "ready", 121),
        i(QR, 132, "Group asks by repository", "blocked", 121, blocked_by=[131]),
        i(QR, 66, "One budgeted reader for Claude's usage", "done", 122),
        i(QR, 111, "Usage card: back to the first prototype's look", "ready", 122),
        i(QR, 133, "Fable's week under Weekly", "blocked", 122, blocked_by=[111]),
        i(QR, 36, "Settings laid out as T3 Code's", "done", 125),
        i(QR, 134, "Connections page in Settings", "ready", 125),
        i(QR, 110, "Rebuild: the snapshot and control files", "ready", 68),
        i(QR, 135, "Rebuild: the dashboard in React", "blocked", 68, blocked_by=[110]),
        i(QR, 108, "The runner fixes what it gets stuck on, and carries on", "needs-triage", 68),
        i(QR, 113, "Live steps read the repo's own doc", "blocked", 68, blocked_by=[f"{LD}#237"]),
        i(QR, 3, "Wake tasks survive DST", "review", pr=4, note="Clean; its checks are running"),
        i(QR, 93, "A failed check names its step", "review", pr=105, note="PR #105 waits for its review, after PR #104"),
        i(QR, 112, "A rebased head's reviews count as one", "ready", filed=True,
          note="Filed by the runner: PR #224 in leads-dashboard got stuck on it"),
        # game-backdrop
        i(GB, 2, "Tray app that restyles a windowed game", "done", 1),
        i(GB, 3, "Black backdrop bound to the game", "done", 1),
        i(GB, 4, "Live changes while a game runs", "review", 1, pr=14, note="A decision thread settles review 2's question first"),
        i(GB, 5, "Ctrl+Alt+B hotkey toggles the backdrop", "ready", 1),
        i(GB, 6, "Keep the mouse inside the game", "ready", 1),
        i(GB, 7, "Game list window", "ready", 1),
        i(GB, 8, "Start at logon and a single .exe", "ready", 1),
        i(GB, 9, "Games that run as administrator", "blocked", 1, blocked_by=[8]),
        i(GB, 23, "Theme picker in the tray", "blocked", 22),
        i(GB, 24, "Image backdrops", "blocked", 22),
        i(GB, 19, "Tray icon in the Windows 11 style", "blocked", blocked_by=["fluent-icons#3"]),
    ]


def _prs(ago) -> list[dict]:
    def e(minutes, actor, kind, sha, title, detail=None, tone=None, findings=None):
        return {"at": ago(minutes), "actor": actor, "kind": kind, "sha": sha, "title": title,
                "detail": detail, "tone": tone, "findings": findings or []}

    def f(id, text, status):
        return {"id": id, "text": text, "status": status}

    day = 24 * 60
    return [
        {
            "repo": LD, "n": 152, "issue": 150, "title": "Ring-to number per Client",
            "head": "7d21e04", "branch": "claude/ring-to-number-150", "url": GH[LD] + "/pull/152",
            "status": "Held for you",
            "next": "Waiting for your answer to the approach note. Rework or fix on gets one more fix round; hold leaves it.",
            "checks": [],
            "timeline": [
                e(4 * day + 328, "claude", "build", "e18a3c0", "Built it and opened PR #152", "5 commits", "ok"),
                e(4 * day + 300, "sol", "review", "e18a3c0", "Review 1: blocking", "2 Important, 1 nit", findings=[
                    f("I-1", "Ring-to number saved without E.164 normalisation", "fixed"),
                    f("I-2", "Owner check reads the Client from before the move", "fixed"),
                    f("N-1", "Rename ringTo to ringToNumber for the glossary", "open")]),
                e(4 * day + 275, "claude", "fix", "e18a3c0", "Fix round 1 pushed 2 commits", "e18a3c0 to 3b9f7a2", "ok"),
                e(4 * day + 249, "sol", "review", "3b9f7a2", "Review 2: blocking", "1 Important", findings=[
                    f("I-3", "Migration adds a NOT NULL column without a default", "fixed")]),
                e(4 * day + 218, "claude", "fix", "3b9f7a2", "Fix round 2 pushed 2 commits", "3b9f7a2 to 7d21e04", "ok"),
                e(140, "sol", "review", "7d21e04", "Review 3: still blocking", "I-4 repeats I-2's class", findings=[
                    f("I-4", "Ring-to check still reads the pre-move owner when the Client is reassigned mid-call", "open")]),
                e(129, "claude", "decision", "7d21e04", "A decision thread wrote an approach note",
                  "Recommends rework: read the owner from the call's routing row, not from the Client"),
                e(128, "runner", "stop", "7d21e04", "Stopped for you", "Filed on needs-info issue #219, toast sent", "you"),
            ],
        },
        {
            "repo": LD, "n": 207, "issue": 191, "title": "A Client's Twilio number on their page",
            "head": "a0d5f6f", "branch": "claude/a-client-s-twilio-191", "url": GH[LD] + "/pull/207",
            "status": "Ready for you to merge",
            "next": "You merge it. Its live steps follow your merge.",
            "checks": [
                {"label": "Clean on a0d5f6f", "ok": True}, {"label": "Checks passed on a0d5f6f", "ok": True},
                {"label": "No conflict", "ok": True}, {"label": "Nothing said since the review", "ok": True},
                {"label": "No job writing to it", "ok": True},
            ],
            "timeline": [
                e(3 * day + 610, "claude", "build", "48ea678", "Built it and opened PR #207", "4 commits", "ok"),
                e(3 * day + 590, "sol", "review", "48ea678", "Review 1: blocking", "1 Important", findings=[
                    f("I-1", "The number shows before the Client's Twilio account is verified", "fixed")]),
                e(3 * day + 570, "claude", "fix", "48ea678", "Fix round 1 pushed 1 commit", "48ea678 to a0d5f6f", "ok"),
                e(48, "sol", "review", "a0d5f6f", "Review 2: clean", None, "ok"),
                e(40, "runner", "ready", "a0d5f6f", "Marked ready for you", "Label ready-for-stefan, toast sent", "you"),
            ],
        },
        {
            "repo": LD, "n": 210, "issue": 205, "title": "Callers list: filter by tag",
            "head": "4be91c2", "branch": "claude/callers-list-filter-205", "url": GH[LD] + "/pull/210",
            "status": "In review", "next": "Sol is on review 1 of 4be91c2.", "checks": [],
            "timeline": [
                e(150, "claude", "build", "4be91c2", "Built it and opened PR #210", "3 commits", "ok"),
                e(12, "sol", "review", "4be91c2", "Review 1 running", None),
            ],
        },
        {
            "repo": LD, "n": 204, "issue": 199, "title": "Unassigned: assign several at once",
            "head": "678425f", "branch": "claude/unassigned-assign-several-199", "url": GH[LD] + "/pull/204",
            "status": "Fix round next", "next": "Claude's fix round on 678425f starts after the current build.", "checks": [],
            "timeline": [
                e(300, "claude", "build", "678425f", "Built it and opened PR #204", "6 commits", "ok"),
                e(85, "sol", "review", "678425f", "Review 1: blocking", "2 Important", findings=[
                    f("I-1", "Assigning 50 or more leads sends one request per lead", "open"),
                    f("I-2", "A lead assigned by someone else meanwhile is overwritten silently", "open")]),
            ],
        },
        {
            "repo": LD, "n": 232, "issue": 217, "title": "Call length on every call",
            "head": "c93b0e5", "branch": "claude/call-length-on-217", "url": GH[LD] + "/pull/232",
            "status": WAITS_FOR_REVIEW, "next": "Sol reviews c93b0e5 after PR #210.", "checks": [],
            "timeline": [
                e(36, "claude", "build", "c93b0e5", "Built it and opened PR #232", "3 commits", "ok"),
            ],
        },
        {
            "repo": QR, "n": 4, "issue": 3, "title": "Wake tasks survive DST",
            "head": "e4c941a", "branch": "claude/wake-tasks-survive-3", "url": GH[QR] + "/pull/4",
            "status": "Clean, checks running", "next": "The runner merges it once its checks pass on e4c941a.",
            "checks": [
                {"label": "Clean on e4c941a", "ok": True}, {"label": "Checks passed on e4c941a", "ok": False},
                {"label": "No conflict", "ok": True}, {"label": "Nothing said since the review", "ok": True},
                {"label": "No job writing to it", "ok": True},
            ],
            "timeline": [
                e(70, "claude", "build", "e4c941a", "Built it and opened PR #4", "2 commits", "ok"),
                e(28, "sol", "review", "e4c941a", "Review 1: clean", None, "ok"),
            ],
        },
    ]


def _activity(prs: list[dict], ago) -> list[dict]:
    """What happened, newest first: every PR's events, and what the runner did between them."""
    def e(minutes, actor, title, detail=None, tone=None, repo=None, pr=None, ref=None):
        return {"at": ago(minutes), "actor": actor, "repo": repo, "pr": pr, "ref": ref or (pr and f"PR #{pr}"),
                "title": title, "detail": detail, "tone": tone}

    day = 24 * 60
    rows = [{"at": t["at"], "actor": t["actor"], "repo": p["repo"], "pr": p["n"], "ref": f"PR #{p['n']}",
             "title": t["title"], "detail": t["detail"], "tone": t["tone"]} for p in prs for t in p["timeline"]]
    rows += [
        e(35, "claude", "Started building #212", "Archive view for old callers", repo=LD, ref="#212"),
        e(52, "claude", "The build of #214 stopped with a question", "A decision thread couldn't answer it", "you", repo=LD, ref="#214"),
        e(95, "you", "Merged PR #203", "Ring-to number in the call log; its live steps are still to run", repo=LD, ref="PR #203"),
        e(399, "runner", "Runner started", "On commit 66a5ea1, after its own PR #2 merged"),
        e(402, "runner", "Merged PR #2", "Clean on its head, checks passed", "ok", repo=QR, ref="PR #2"),
        e(day + 95, "claude", "Went live: PR #198 and PR #201", "2 migrations applied, 1 function deployed", "ok", repo=LD, ref="PR #201"),
        e(day + 130, "you", "Merged PR #201", "Caller notes on the caller's page", repo=LD, ref="PR #201"),
        e(day + 300, "runner", "Claude waited 2 h for its session to reset", "A fix round needed 34% and 21% was left"),
    ]
    return sorted(rows, key=lambda r: datetime.fromisoformat(r["at"]), reverse=True)


def _lane(snap: dict, id: str) -> dict:
    return next(l for l in snap["lanes"] if l["id"] == id)


def _issue(snap: dict, repo: str, n: int) -> dict:
    return next(i for i in snap["issues"] if i["repo"] == repo and i["n"] == n)


def _source(snap: dict, id: str) -> dict:
    return next(s for s in snap["sources"] if s["id"] == id)


def _vary(snap: dict, name: str, ago, ahead) -> None:
    if name == "clear":
        snap["asks"] = []
        snap["answered"] = []
        _issue(snap, LD, 191).update(state="done", note=None)
        _issue(snap, LD, 150).update(state="fixing", note="You said rework; its fix round is queued")
        _issue(snap, LD, 214).update(state="ready", note=None)
        _issue(snap, LD, 217).update(state="merged", note="Its live steps wait for the review of PR #210")
        next(p for p in snap["prs"] if p["n"] == 232).update(
            status="Merged, not live yet", next="Its live steps run after the review of PR #210.")
    elif name == "many":
        snap["asks"] += [
            {"id": "ask-live", "kind": "broken", "repo": LD, "ref": "PR #198", "pr": None, "subject": "Caller notes", "since": ago(6),
             "situation": "The live steps for PR #198 stopped halfway.",
             "about": "Notes a rep writes about a caller, shown on the caller's page. You merged it yesterday.",
             "because": "The second migration failed: column \"owner_id\" already exists. The first is applied, so the database sits between the two.",
             "story": ["Yesterday: you merged PR #198", "Today: deployed, migration 1 of 2 applied", "Migration 2 failed"],
             "question": "What should happen to the second migration?",
             "holds_up": ["Every later live run in leads-dashboard"],
             "go": {"label": "Decide in T3", "where": "t3", "url": T3 + "136ab19d-14d7-4f6a-a235-4e1ac0ebb043"},
             "why": ["Deployed; 1 of 2 migrations applied.", "20261114_number_owner.sql failed: column \"owner_id\" already exists."]},
            {"id": "ask-qr4", "kind": "stuck", "repo": QR, "ref": "PR #4", "pr": 4, "subject": "Wake tasks survive DST", "since": ago(3),
             "situation": "The tests failed for a reason the change doesn't explain.",
             "about": "Wake tasks are named with their UTC offset, so a clock change can't merge two of them.",
             "because": "test_wake.py timed out once in CI and passes locally. A decision thread couldn't tell a flake from a fault.",
             "story": ["Today: built, PR #4 opened", "Review 1 clean", "The tests timed out on Windows"],
             "question": "Run the tests again, or look first?", "holds_up": [],
             "go": {"label": "Open the needs-info issue", "where": "github", "url": GH[QR] + "/issues/6"},
             "decide": {"state": "offered", "at": None, "note": None},
             "why": ["test_wake.py timed out once in CI and passes locally."]},
            {"id": "ask-ops", "kind": "decision", "repo": LD, "ref": "#231", "pr": None, "subject": "Monthly report email", "since": ago(1),
             "situation": "The issue names two different recipients.",
             "about": "An email each month with a Client's call counts and where their leads came from.",
             "because": "It says the Client's owner in one place and everyone on the account in another. The build stopped before writing the recipient list.",
             "story": ["Today: the build started", "It stopped at the recipient list"],
             "question": "Who receives the monthly report: the Client's owner, or everyone on the account?", "holds_up": [],
             "go": {"label": "Answer in T3", "where": "t3", "url": T3 + "5823cce7-a3a7-4ac6-9f2b-5883404d9828"},
             "why": ["The issue names both in different places."]},
        ]
    elif name == "stale":   # issue #72: the runner settled both cold threads
        cold = ("Its thread went cold (its prompt cache expired {at}), so the runner settled it. A fresh "
                "thread starts from its brief and the cold one's last messages, so nothing is re-read uncached.")
        stuck = next(a for a in snap["asks"] if a["id"] == "ask-152")
        stuck["go"], stuck["also"] = stuck["also"], None
        stuck["decide"] = {"state": "stale", "at": ago(65), "label": "Decide in a fresh T3 thread",
                           "note": cold.format(at=ago(65)[11:16])}
        waiting = next(a for a in snap["asks"] if a["id"] == "ask-214")
        waiting["since"] = ago(75)
        waiting["decide"] = {"state": "stale", "at": ago(10), "label": "Answer in a fresh T3 thread",
                             "note": cold.format(at=ago(10)[11:16])}
    elif name == "reserve":
        snap["usage"][0]["windows"][1]["used"] = 93
        _lane(snap, "claude").update(state="waiting", job=None, next="Fix round on PR #204", wait={
            "until": snap["usage"][0]["windows"][1]["reserve_opens_at"],
            "reason": "The week is at 93%, and a fix round is expected to take 6%. That would use the 5% kept for you."})
        _issue(snap, LD, 212).update(state="ready", note=None)
    elif name == "limit":
        snap["usage"][0]["windows"][0]["used"] = 100
        _lane(snap, "claude").update(state="waiting", next="Carries on with #212 in the same thread", wait={
            "until": ahead(70), "reason": "The build of #212 hit Claude's session limit. It resumes 10 minutes after the reset."})
    elif name == "github-down":
        _source(snap, "github").update(ok=False, note="No answer since then (HTTP 503)", checked_at=ago(18),
                                       affects="Asks, PRs and the work list are as they were then; some may be missing.")
    elif name == "reconnecting":   # a failure is red only once it lasts (usage.SHOW_AFTER)
        for id, good in (("github", 362), ("claude_usage", 361), ("sol_usage", 361)):
            _source(snap, id).update(note="Reconnecting", checked_at=ago(good), retrying=ago(3))
        for p, good in zip(snap["usage"], (361, 361)):
            p.update(read_at=ago(good), retrying=ago(3), next_read_at=ahead(2) if p["id"] == "claude" else None)
    elif name == "usage-stale":   # a failure shows only past 30 minutes (issue 66)
        snap["usage"][0].update(read_at=ago(40), next_read_at=ahead(3), error=(
            "The usage endpoint answered HTTP 429; the reading is over 30 minutes old, so no Claude job "
            "starts until a read answers."))
        _source(snap, "claude_usage").update(ok=False, note="the usage endpoint answered HTTP 429", checked_at=ago(40))
        _lane(snap, "claude").update(state="waiting", job=None, wait={
            "until": ahead(3), "reason": "Claude usage was last read 40 minutes ago (the latest read failed: the "
            "usage endpoint answered HTTP 429): no Claude job starts until the next read."})
    elif name == "asked-again":   # #85: told to the gate by run id, seen running or not
        snap["usage"][0].update(read_at=ago(4), next_read_at=ahead(1))
        _lane(snap, "claude").update(state="waiting", job=None, wait={
            "until": ahead(1), "reason": f"Claude usage was last read at {ago(4)[11:16]}, before the last "
            f"Claude job ended: no Claude job starts, until the next read at {ahead(1)[11:16]}."})
    elif name == "repo-stopped":
        _repo(snap, LD)["stopped"] = {"at": ago(6)}   # after the jobs on it began
    elif name == "side-by-side":   # #50: each repo runs its own Claude job
        claude = _lane(snap, "claude")
        _issue(snap, QR, 112).update(state="building", note="Claude is building it")
        claude["jobs"] = [claude["job"], {
            "kind": "build", "repo": QR, "ref": "#112", "title": "A rebased head's reviews count as one",
            "started_at": ago(8), "sha": None, "pr": None, "thread": T3 + "6b1d0a52-5d0e-4c7b-9f4e-2f0c0c1b8e11"}]
        claude["job"] = claude["jobs"][-1]
    elif name == "no-interrupt":
        # Stop now isn't a source the runner depends on (ticket 43): it shows on the Stop button.
        _lane(snap, "claude")["stop_now"].update(available=False, note="T3 refuses the interrupt since its last update: stop after the job instead.")


def _obey(snap: dict, control: dict, now: datetime) -> None:
    """The pretend runner: a few seconds after control.json is written, it has read it."""
    written = control.get("written_at")
    if not written:
        return
    try:
        age = (now - datetime.fromisoformat(written)).total_seconds()
    except ValueError:
        return
    if age < ACK_SECONDS:
        return
    snap["control_read_at"] = written
    for lane in snap["lanes"]:
        ask = (control.get("lanes") or {}).get(lane["id"]) or {}
        stop, job = ask.get("stop"), lane["job"]
        if stop == "after-job" and job and lane["state"] == "working":
            lane["state"] = "stopping"
        elif stop:
            was = f"{job['ref']} {job['title']}" if job else None
            lane.update(state="stopped", job=None, wait=None, stopped={"at": ask.get("at"), "during": was if stop == "now" else None})
            if was and stop == "now":
                lane["next"] = f"{job['ref']} carries on from where it stopped" if lane["id"] == "claude" else f"{job['ref']} is reviewed afresh"
    for repo in snap["repos"]:   # a repo's stop (ticket 37)
        ask = (control.get("repos") or {}).get(repo["name"])
        if isinstance(ask, dict) and "stop" in ask:
            repo["stopped"] = {"at": ask.get("at")} if ask["stop"] else None
    claude = _lane(snap, "claude")
    for ask in snap["asks"]:   # Decide in T3 (ticket 35): read, it starts on the next pass
        record = (control.get("asks") or {}).get(ask["id"])
        if (ask.get("decide") or {}).get("state") == "offered" and isinstance(record, dict) and isinstance(record.get("open"), dict):
            note = ("It starts when you resume the Claude lane." if claude["state"] == "stopped"
                    else f"It starts once Claude's current {claude['job']['kind']} ends." if claude["job"]
                    else "It starts on the Claude lane's next pass.")
            ask["decide"] = {"state": "asked", "at": record["open"].get("at"), "note": note}
        elif (ask.get("decide") or {}).get("state") == "stale" and isinstance(record, dict) and isinstance(record.get("fresh"), dict):
            ask["decide"] = dict(ask["decide"], state="asked", at=record["fresh"].get("at"),
                                 note="A fresh thread starts on the Claude lane's next pass.")   # issue #72
    marks = control.get("asks") if isinstance(control.get("asks"), dict) else {}
    for ask in snap["asks"] + snap["answered"]:   # read and snoozed (ticket 36)
        mark = marks.get(ask["id"])
        if not isinstance(mark, dict):
            continue
        ask["read"] = mark.get("read") is True
        until = mark.get("snooze_until")
        try:
            ahead = isinstance(until, str) and datetime.fromisoformat(until) > now
        except (TypeError, ValueError):   # not a time, or one with no offset
            ahead = False
        ask["snoozed_until"] = until if ahead else None   # a snooze whose time has passed is over
    usage = control.get("usage")   # Refresh (ticket 42): both plans read as the request is read
    if isinstance(usage, dict) and isinstance(usage.get("refresh_at"), str):
        read = (datetime.fromisoformat(written) + timedelta(seconds=ACK_SECONDS)).isoformat(timespec="seconds")
        snap["usage_refresh"] = {"asked_at": usage["refresh_at"], "done_at": read}
        for plan in snap["usage"]:   # Claude's inside its 5-minute budget keeps its reading (issue 66)
            if plan["next_read_at"] and datetime.fromisoformat(plan["next_read_at"]) > datetime.fromisoformat(read):
                continue
            plan["read_at"] = read
            if plan["id"] == "claude":
                plan["next_read_at"] = (datetime.fromisoformat(read) + timedelta(minutes=5)).isoformat(timespec="seconds")


def _doing(snap: dict) -> None:
    """The Claude lane's `jobs` (one per repo, #50; `job` the newest), and what each repo is
    doing: `doing`, the job running in it, else `wait`, why none starts (the lane's wait)."""
    claude = _lane(snap, "claude")
    running = claude["state"] in ("working", "stopping") and claude["job"]
    claude["jobs"] = (claude.get("jobs") or [claude["job"]]) if running else []
    for lane in snap["lanes"]:
        lane.setdefault("jobs", [lane["job"]] if lane["job"] else [])
    for repo in snap["repos"]:
        repo["doing"] = next((j for j in claude["jobs"] if j["repo"] == repo["name"]), None)
        repo["wait"] = (claude["wait"] if claude["state"] == "waiting" and not repo["doing"]
                        and not repo["stopped"] else None)


def _order(snap: dict) -> None:
    """Features in build order: the repos' order, then the feature whose first open ticket has the
    lowest number (the runner builds lowest number first). One with nothing open goes last."""
    rank = {r["name"]: k for k, r in enumerate(snap["repos"])}

    def first_open(f: dict) -> float:
        return min((i["n"] for i in snap["issues"] if i["feature"] == f["id"] and i["state"] != "done"), default=float("inf"))
    snap["features"].sort(key=lambda f: (first_open(f) == float("inf"), rank[f["repo"]], first_open(f)))


# How far along a ticket is, furthest first: the order of a feature's progress bar.
_FAR = {"done": 0, "merged": 1, "review": 2, "fixing": 2, "building": 3, "you": 4}


def _tickets(snap: dict) -> None:
    """Each feature's tickets (`tickets`: their `repo#n` keys) in the order they're built. What has
    started comes first, furthest along first. Then what hasn't: a blocker before what it blocks,
    the lowest number first (as the runner picks), and one not marked ready last."""
    for f in snap["features"]:
        its = [i for i in snap["issues"] if i["feature"] == f["id"]]
        started = sorted((i for i in its if i["state"] in _FAR), key=lambda i: (_FAR[i["state"]], i["n"]))
        rest = {f"{i['repo']}#{i['n']}": i for i in its if i["state"] not in _FAR}
        later = []
        while rest:
            free = [i for i in rest.values() if not any(b in rest for b in i["blocked_by"])] or list(rest.values())
            nxt = min(free, key=lambda i: (i["state"] == "not-ready", i["n"]))
            later.append(nxt)
            del rest[f"{nxt['repo']}#{nxt['n']}"]
        f["tickets"] = [f"{i['repo']}#{i['n']}" for i in started + later]


def _queue(snap: dict) -> None:
    """Each lane's own queue, in the order it takes them up: a job a limit cut off, Claude's fix
    rounds, then its builds in pick order; the PRs waiting for Sol's review. `next` is read by
    the earlier takes only."""
    claude = _lane(snap, "claude")
    job = claude["job"] or {}
    held = [{"kind": job["kind"], "repo": job["repo"], "ref": job["ref"], "title": job["title"]}] if job and claude["state"] == "waiting" else []
    fixes = [{"kind": "fix", "repo": i["repo"], "ref": f"PR #{i['pr']}", "title": i["title"]}
             for i in snap["issues"] if i["state"] == "fixing" and f"PR #{i['pr']}" != job.get("ref")]
    builds = [{"kind": "build", "repo": i["repo"], "ref": f"#{i['n']}", "title": i["title"]}
              for i in sorted((i for i in snap["issues"] if i["pick"]), key=lambda i: i["pick"])]
    off = _stopped(snap)   # a stopped repo's work is in no lane's queue (ticket 37)
    claude["queue"] = [q for q in held + fixes + builds if q["repo"] not in off]
    reviews = [{"kind": "review", "repo": p["repo"], "ref": f"PR #{p['n']}", "title": p["title"]}
               for p in snap["prs"] if p["status"] == WAITS_FOR_REVIEW and p["repo"] not in off]
    _lane(snap, "sol").update(queue=reviews, queue_empty="Nothing is waiting for review.")


def _repo(snap: dict, name: str) -> dict:
    return next(r for r in snap["repos"] if r["name"] == name)


def _stopped(snap: dict) -> set:
    return {r["name"] for r in snap["repos"] if r.get("stopped")}


def _number(snap: dict) -> None:
    """The order the runner would build in: the first repo with ready work, lowest number first."""
    rank = {r["name"]: k for k, r in enumerate(snap["repos"])}
    off = _stopped(snap)   # a stopped repo's ready work isn't built until it's resumed
    ready = sorted((i for i in snap["issues"] if i["state"] == "ready" and i["repo"] not in off),
                   key=lambda i: (rank[i["repo"]], i["n"]))
    for k, i in enumerate(ready, 1):
        i["pick"] = k


if __name__ == "__main__":
    import json
    import sys
    print(json.dumps(build(sys.argv[1] if len(sys.argv) > 1 else DEFAULT), indent=1))
