"""Sample snapshots: the file the runner will publish, in each state the page has to show.

`build(name)` returns a whole `snapshot.json` (version 1) with its times set around now, so the
page can be judged without a runner. The shape here is the contract the runner's side is built
to. It also plays the runner reading `control.json` (a few seconds after it's written), so the
stop buttons and the build order can be tried; that part is the sample's only pretence.

Every time is an ISO string with its UTC offset; the page does the formatting.
"""
from __future__ import annotations

from datetime import datetime, timedelta

LD, QR = "leads-dashboard", "queue-runner"
GH = {LD: "https://github.com/RoyalBullyAgency-RBA/leads-dashboard", QR: "https://github.com/stefan1575/queue-runner"}
T3 = "https://app.t3.codes/threads/264b77bb-5ec7-4453-8ee5-7d0162886008/mcp%3A"

STATES = {
    "busy": "Three asks, both lanes working",
    "clear": "Nothing needs you",
    "many": "Six asks",
    "reserve": "Claude waits: the rest of the week is kept for you",
    "limit": "Claude hit its session limit in the middle of a build",
    "github-down": "GitHub can't be read",
    "no-interrupt": "T3 refuses the interrupt, so Stop now is off for Claude",
    "dead": "The runner stopped writing 42 minutes ago",
}
DEFAULT = "busy"
# Takes of the page before this one, kept while its look is being agreed: `serve.py` serves the
# ones in `dashboard/earlier/` in sample mode, and the sidebar's sample menu links them.
EARLIER = [
    {"href": "/earlier/take-3.html", "label": "Take 3", "note": "Lanes on top, a tab per ask, status first on the right"},
    {"href": "/earlier/take-2.html", "label": "Take 2", "note": "The asks listed beside the open one, lanes below, health in the sidebar"},
    {"href": "/earlier/take-1.html", "label": "Take 1", "note": "One page, no sidebar, the asks as bright slips"},
    {"href": "http://localhost:5288/", "label": "Prototype round 4", "note": "The React prototype, while its dev server runs"},
]
ACK_SECONDS = 3   # how long the pretend runner takes to read control.json


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
            # `short` is the name beside its dot in the sidebar
            {"id": "github", "name": "GitHub", "short": "GitHub", "ok": True, "note": "gh as stefan1575", "checked_at": ago(1)},
            {"id": "t3", "name": "T3 Code", "short": "T3 Code", "ok": True, "note": "server up", "checked_at": ago(1)},
            {"id": "claude_usage", "name": "Claude usage", "short": "Claude", "ok": True, "note": "read", "checked_at": ago(1)},
            {"id": "sol_usage", "name": "ChatGPT usage", "short": "ChatGPT", "ok": True, "note": "read", "checked_at": ago(9)},
            {"id": "t3_interrupt", "name": "Stop now for Claude", "short": "Stop now", "ok": True,
             "note": "T3 accepts the interrupt", "checked_at": ago(399)},
        ],
        "repos": [
            {"name": LD, "github": GH[LD], "merge": "stefan"},
            {"name": QR, "github": GH[QR], "merge": "runner"},
        ],
        # An ask is written to be picked up cold, a week later. `kind` is why it came to Stefan:
        # `stuck` (the runner tried and couldn't get it through), `decision` (a product decision
        # is his), `merge` (ready, his to merge) or `broken` (something failed). `situation` says
        # it in a sentence, `about` what the work is, `because` the specifics, `story` what has
        # happened, in order; then `question`, `options` and where it's answered (`go`).
        # `why` is read by the earlier takes only, and goes when they do.
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
                "go": {"label": "Decide in T3", "url": T3 + "0481ebdf-41e8-4253-b3a1-3be2d40a80b2"},
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
                "go": {"label": "Open PR to merge", "url": GH[LD] + "/pull/207"},
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
                "go": {"label": "Answer in T3", "url": T3 + "0d6566e9-86a3-4e0f-a64a-e0443d93d0fe"},
                "why": [
                    "The build stopped before writing the form's required fields.",
                    "A decision thread couldn't answer it from the issue.",
                ],
            },
        ],
        "lanes": [
            {
                # `provider` picks the mark and the name's type: "claude" or "chatgpt"; any other gets none
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
            {"id": "claude", "provider": "claude", "name": "Claude", "plan": None, "read_at": ago(1), "error": None, "windows": [
                {"id": "five_hour", "label": "Session", "used": 38, "resets_at": ahead(60), "gates": True},
                {"id": "week", "label": "Weekly", "used": 46, "resets_at": ahead(60 * 49.7), "gates": True,
                 "reserve": 5, "reserve_opens_at": ahead(60 * 25.7)},
                {"id": "week_fable", "label": "Weekly, Fable", "used": 100, "resets_at": ahead(60 * 49.7),
                 "gates": False, "note": "The runner doesn't use Fable."},
            ]},
            {"id": "sol", "provider": "chatgpt", "name": "ChatGPT", "plan": None, "read_at": ago(9), "error": None, "windows": [
                {"id": "five_hour", "label": "Session", "used": 26, "resets_at": ahead(94), "gates": True},
                {"id": "week", "label": "Weekly", "used": 6, "resets_at": ahead(60 * 152.9), "gates": True},
            ]},
        ],
        "knob": {"paused": False, "reserve": 5},   # gate.json, as the runner last read it
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
        "features": [
            {"id": f"{LD}#225", "repo": LD, "n": 225, "title": "Analytics"},
            {"id": f"{LD}#149", "repo": LD, "n": 149, "title": "Ring-to numbers"},
            {"id": f"{LD}#220", "repo": LD, "n": 220, "title": "Client onboarding"},
            {"id": f"{LD}#200", "repo": LD, "n": 200, "title": "Callers"},
            {"id": f"{QR}#9", "repo": QR, "n": 9, "title": "Dashboard"},
        ],
        "issues": _issues(),
        "prs": _prs(ago),
    }
    snap["activity"] = _activity(snap["prs"], ago)
    _vary(snap, name, ago, ahead)
    if name == "dead":
        snap["written_at"] = (now - timedelta(minutes=42)).isoformat(timespec="seconds")
    else:
        _obey(snap, control or {}, now)
    _number(snap)
    _queue(snap)
    # The page lists them in the sidebar; the runner's file has no such key.
    snap["sample"] = {"state": name, "states": STATES, "earlier": EARLIER}
    return snap


def _issues() -> list[dict]:
    def i(repo, n, title, state, feature=None, pr=None, blocked_by=(), note=None):
        return {"repo": repo, "n": n, "title": title, "state": state, "feature": feature and f"{repo}#{feature}",
                "pr": pr, "blocked_by": [f"{repo}#{b}" for b in blocked_by], "note": note, "pick": None}
    return [
        i(LD, 226, "Store call events", "ready", 225),
        i(LD, 227, "Daily rollup of events", "blocked", 225, blocked_by=[226]),
        i(LD, 228, "Charts page", "blocked", 225, blocked_by=[227]),
        i(LD, 229, "Lead source report", "blocked", 225, blocked_by=[227, 196]),
        i(LD, 230, "Export analytics as CSV", "blocked", 225, blocked_by=[228]),
        i(LD, 196, "Lead source on every call", "done", 225),
        i(LD, 191, "A Client's Twilio number on their page", "you", 149, pr=207, note="PR #207 is ready for you to merge"),
        i(LD, 150, "Ring-to number per Client", "you", 149, pr=152, note="PR #152 waits for your decision"),
        i(LD, 216, "Ring-to audit page", "blocked", 149, blocked_by=[150]),
        i(LD, 214, "Client onboarding form", "you", 220, note="Its build waits for your answer"),
        i(LD, 215, "SEO questions on the form", "blocked", 220, blocked_by=[214]),
        i(LD, 223, "Welcome email after the form", "blocked", 220, blocked_by=[214]),
        i(LD, 205, "Callers list: filter by tag", "review", 200, pr=210, note="Sol is reviewing PR #210"),
        i(LD, 212, "Archive view for old callers", "building", 200, note="Claude is building it"),
        i(LD, 218, "Export calls as CSV", "not-ready", 200, note="Not marked ready-for-agent"),
        i(LD, 199, "Unassigned: assign several at once", "fixing", pr=204, note="Its fix round on PR #204 is next"),
        i(LD, 211, "Domain health check", "ready"),
        i(QR, 5, "Publish the snapshot the dashboard reads", "ready", 9),
        i(QR, 6, "Read control.json: stop a lane, build order", "ready", 9),
        i(QR, 7, "Start the dashboard at logon", "blocked", 9, blocked_by=[5]),
        i(QR, 8, "Stop now through T3's interrupt", "blocked", 9, blocked_by=[6, 7]),
        i(QR, 3, "Wake tasks survive DST", "review", pr=4, note="Clean; its checks are running"),
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
        _issue(snap, LD, 191).update(state="done", note=None)
        _issue(snap, LD, 150).update(state="fixing", note="You said rework; its fix round is queued")
        _issue(snap, LD, 214).update(state="ready", note=None)
    elif name == "many":
        snap["asks"] += [
            {"id": "ask-live", "kind": "broken", "repo": LD, "ref": "PR #198", "pr": None, "subject": "Caller notes", "since": ago(6),
             "situation": "The live steps for PR #198 stopped halfway.",
             "about": "Notes a rep writes about a caller, shown on the caller's page. You merged it yesterday.",
             "because": "The second migration failed: column \"owner_id\" already exists. The first is applied, so the database sits between the two.",
             "story": ["Yesterday: you merged PR #198", "Today: deployed, migration 1 of 2 applied", "Migration 2 failed"],
             "question": "What should happen to the second migration?",
             "holds_up": ["Every later live run in leads-dashboard"],
             "go": {"label": "Decide in T3", "url": T3 + "136ab19d-14d7-4f6a-a235-4e1ac0ebb043"},
             "why": ["Deployed; 1 of 2 migrations applied.", "20261114_number_owner.sql failed: column \"owner_id\" already exists."]},
            {"id": "ask-qr4", "kind": "stuck", "repo": QR, "ref": "PR #4", "pr": 4, "subject": "Wake tasks survive DST", "since": ago(3),
             "situation": "The tests failed for a reason the change doesn't explain.",
             "about": "Wake tasks are named with their UTC offset, so a clock change can't merge two of them.",
             "because": "test_wake.py timed out once in CI and passes locally. A decision thread couldn't tell a flake from a fault.",
             "story": ["Today: built, PR #4 opened", "Review 1 clean", "The tests timed out on Windows"],
             "question": "Run the tests again, or look first?", "holds_up": [],
             "go": {"label": "Decide in T3", "url": T3 + "89d3ed68-05f2-418f-afd8-9b4a28709ddc"},
             "why": ["test_wake.py timed out once in CI and passes locally."]},
            {"id": "ask-ops", "kind": "decision", "repo": LD, "ref": "#231", "pr": None, "subject": "Monthly report email", "since": ago(1),
             "situation": "The issue names two different recipients.",
             "about": "An email each month with a Client's call counts and where their leads came from.",
             "because": "It says the Client's owner in one place and everyone on the account in another. The build stopped before writing the recipient list.",
             "story": ["Today: the build started", "It stopped at the recipient list"],
             "question": "Who receives the monthly report: the Client's owner, or everyone on the account?", "holds_up": [],
             "go": {"label": "Answer in T3", "url": T3 + "5823cce7-a3a7-4ac6-9f2b-5883404d9828"},
             "why": ["The issue names both in different places."]},
        ]
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
    elif name == "no-interrupt":
        _source(snap, "t3_interrupt").update(ok=False, note="T3 refused the session (HTTP 426: protocol 3 expected)",
                                             affects="Stop after this job still works.")
        _lane(snap, "claude")["stop_now"].update(available=False, note="T3 refuses the interrupt since its last update.")


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
    order = control.get("repo_order") or []
    names = [r["name"] for r in snap["repos"]]
    if sorted(order) == sorted(names):
        snap["repos"].sort(key=lambda r: order.index(r["name"]))


def _queue(snap: dict) -> None:
    """Each lane's own queue, in the order it takes them up: Claude's fix rounds, then its builds
    in pick order; the reviews waiting for Sol. `next` is read by the earlier takes only."""
    job = _lane(snap, "claude")["job"] or {}
    fixes = [{"kind": "fix", "repo": i["repo"], "ref": f"PR #{i['pr']}", "title": i["title"]}
             for i in snap["issues"] if i["state"] == "fixing" and f"PR #{i['pr']}" != job.get("ref")]
    builds = [{"kind": "build", "repo": i["repo"], "ref": f"#{i['n']}", "title": i["title"]}
              for i in sorted((i for i in snap["issues"] if i["pick"]), key=lambda i: i["pick"])]
    _lane(snap, "claude")["queue"] = fixes + builds
    _lane(snap, "sol").update(queue=[], queue_empty="Nothing is waiting for review.")


def _number(snap: dict) -> None:
    """The order the runner would build in: the first repo with ready work, lowest number first."""
    rank = {r["name"]: k for k, r in enumerate(snap["repos"])}
    ready = sorted((i for i in snap["issues"] if i["state"] == "ready"), key=lambda i: (rank[i["repo"]], i["n"]))
    for k, i in enumerate(ready, 1):
        i["pick"] = k


if __name__ == "__main__":
    import json
    import sys
    print(json.dumps(build(sys.argv[1] if len(sys.argv) > 1 else DEFAULT), indent=1))
