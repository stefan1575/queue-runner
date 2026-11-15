"""The review ledger, with no I/O: earlier reviews read from a PR's comments, and decide(), which
works out a review's verdict and outcome from Sol's sol-findings block, never from its prose.

Ported from `~/sol-pr-review.py` (`decide()`, the marker and block parsing) without its labels,
spend guard, token counts or session forks. leads-dashboard's `docs/agents/review-loop.md` and
`REVIEW.md` define the words; `~/Code/docs/pr-review.md` the loop.

A PR's state lives in its review comments. The newest one holds every finding raised so far, each
with a status, so a review reads only the newest. Three formats are read:
- the old script's and the runner's hidden marker,
  `<!-- sol-pr-review round=N verdict=V sha=H findings=<base64 JSON> ... -->`;
- a review Sol posted itself from a T3 child (2026-11-06, leads-dashboard #168):
  `<!-- sol-review round=N head=H -->`, its verdict in the `## Sol review N · V` heading and its
  findings in the comment's visible sol-findings block.
The runner's own comments carry both the marker and a visible sol-findings ledger.
"""
import base64
import json
import re
import urllib.parse

MARK = re.compile(r'<!-- sol-pr-review round=(\d+) verdict=(clean|blocking)(?: sha=([0-9a-f]+))?')
HAND_MARK = re.compile(r'<!-- sol-review round=(\d+) head=([0-9a-f]{7,40}) -->')
HEADING = re.compile(r'^## Sol review (\d+)\s*\S\s*(Clean|Blocking)\b', re.I | re.M)
FENCE = re.compile(r'^[ \t]*```+[ \t]*sol-findings[ \t]*\r?\n(.*?)^[ \t]*```+[ \t]*$', re.M | re.S)
TAGS = {'important': 'Important', 'nit': 'Nit', 'pre-existing': 'Pre-existing'}
FIELDS = ('id', 'tag', 'class', 'file', 'line', 'scenario', 'cost', 'rule')
MAX_NITS = 5
# A finding's status. Sol gives an earlier open finding one of STATUSES; a new finding is open,
# or filed when pre-existing. decline-kept stays apart from open: it goes to Stefan.
STATUSES = {'fixed': 'Fixed', 'open': 'Still open', 'decline-accepted': 'Decline accepted',
            'decline-kept': 'Decline kept open'}
OPEN = ('open', 'decline-kept')
# From this review on, a blocking review comes to Stefan with an approach note, not a fix round
# (pr-review.md: no fourth review without his answer). The old script did it at review 3 only,
# with its spend guard behind it; with that guard gone, every later blocking review does too.
APPROACH_REVIEW = 3
# Every comment the runner posts outside a review carries a hidden line starting with this: the
# runner's own post, never a reply from Stefan, though it's on his account.
RUNNER_MARK = '<!-- queue-runner '
# The hidden line on the runner's comment recording a stop on a PR (`stops.py`).
STOP_MARK = RUNNER_MARK + 'stop '
# Where a comment's collapsed ledger starts: everything after it is the ledger and the marker.
LEDGER = '<details><summary>Ledger</summary>'


class SolFailed(Exception):
    """The review failed: Sol's reply has no readable ledger, or Sol's run failed."""


def _text(v) -> str:
    return '' if v is None else str(v).strip()


# --- earlier reviews ----------------------------------------------------------------------------

def _marker_findings(body: str, start: int) -> list | None:
    """The marker's base64 findings, or None if they can't be read. A marker with no findings
    field holds none: the old script's markers before 2026-11-05 (leads-dashboard #139) end at
    `sha=`. An empty field is never written (the runner and the old script write `W10=` for no
    findings), so it can't be read."""
    end = body.find('-->', start)
    field = re.search(r'\bfindings=(\S*)', body[start:end if end >= 0 else len(body)])
    if not field:
        return []
    try:
        found = json.loads(base64.b64decode(field[1], validate=True))
    except ValueError:
        return None
    return found if isinstance(found, list) else None


def _visible_findings(body: str) -> list | None:
    """The findings in a comment's last sol-findings block; None if there's no readable one."""
    blocks = FENCE.findall(body)
    try:
        data = json.loads(blocks[-1]) if blocks else None
    except ValueError:
        return None
    found = data.get('findings') if isinstance(data, dict) else None
    return [f for f in found if isinstance(f, dict)] if isinstance(found, list) else None


def read_review(body: str, at: str = '') -> dict | None:
    """One comment's review: {round, verdict, sha, findings, at}, or None if it isn't one. A
    review whose ledger can't be read isn't one: it failed, so it isn't counted and doesn't
    replace the PR's state (pr-review.md)."""
    if m := MARK.search(body):
        found = _marker_findings(body, m.start())
        if found is None:
            return None
        return {'round': int(m[1]), 'verdict': m[2], 'sha': m[3], 'findings': found, 'at': at}
    if m := HAND_MARK.search(body):
        h = HEADING.search(body)
        rnd = int(m[1])
        visible = _visible_findings(body)
        if visible is None:
            return None
        found = [{**f, 'raised': f.get('raised') or rnd} for f in visible]
        verdict = h[2].lower() if h else (
            'blocking' if any(f.get('tag') == 'important' and f.get('status', 'open') in OPEN
                              for f in found) else 'clean')
        return {'round': rnd, 'verdict': verdict, 'sha': m[2], 'findings': found, 'at': at}
    return None


def read_reviews(comments) -> list[dict]:
    """The PR's reviews, oldest first, from its comments (`github.Comment`s, oldest first)."""
    return [r for c in comments if (r := read_review(c.body or '', c.created_at))]


def newest_on(comments, sha: str, verdict: str) -> dict | None:
    """The PR's newest review, if it's on `sha` with this verdict: no later review has
    replaced the one the runner acts on."""
    reviews = read_reviews(comments)
    last = reviews[-1] if reviews else None
    if last and last['sha'] and sha.startswith(last['sha']) and last['verdict'] == verdict:
        return last
    return None


def runner_post(body: str) -> bool:
    """A review (any format), or a stop, an Approach note or anything else the runner posted:
    not something a person said."""
    body = body or ''
    return (read_review(body) is not None or '<!-- sol-pr-review' in body
            or RUNNER_MARK in body)


def said_since(comments, at: str) -> list:
    """What people said on the PR after `at` (GitHub's UTC time): bots and the runner's own
    reviews and stop records left out."""
    return [c for c in comments if c.created_at > at and not c.author.endswith('[bot]')
            and not runner_post(c.body)]


def next_round(earlier: list[dict]) -> int:
    """Reviews the old script posted count: numbering carries on from the newest."""
    return 1 + max((r['round'] for r in earlier), default=0)


def state(earlier: list[dict]) -> list[dict]:
    """The PR's findings as its newest review left them, each with a status and the review that
    raised it. A marker from before statuses existed counts pre-existing as filed, the rest open."""
    if not earlier:
        return []
    m = earlier[-1]
    return [{**dict.fromkeys(FIELDS, ''), 'line': None, **f,
             'status': f.get('status') or ('filed' if f.get('tag') == 'pre-existing' else 'open'),
             'raised': f.get('raised') or m['round']}
            for f in m['findings'] if isinstance(f, dict) and f.get('id') and f.get('tag') in TAGS]


def norm(c: str) -> str:
    """A class name as reviews compare it: lower case, words only."""
    return ' '.join(re.findall(r'[^\W_]+', (c or '').lower()))


# --- Sol's reply ----------------------------------------------------------------------------------

def _block(reply: str):
    blocks = FENCE.findall(reply)
    if not blocks:
        raise SolFailed("Sol's reply has no ```sol-findings block, so it can't be read as clean "
                        "or blocking.")
    try:
        return json.loads(blocks[-1])
    except ValueError as e:
        raise SolFailed(f"Sol's sol-findings block isn't valid JSON ({e}).") from None


def parse_findings(reply: str) -> tuple[list[dict], str]:
    """Sol's last sol-findings block as normalised findings, and the reply without the block."""
    data = _block(reply)
    items = data.get('findings') if isinstance(data, dict) else None
    if not isinstance(items, list) or not all(isinstance(f, dict) for f in items):
        raise SolFailed("Sol's sol-findings block has no \"findings\" list of objects.")
    found = []
    for i, f in enumerate(items, 1):
        g = {k: _text(f.get(k)) for k in FIELDS}
        tag = re.sub(r'[\s_]+', '-', g['tag'].lower())
        g['tag'] = 'pre-existing' if tag == 'preexisting' else tag
        if not g['id']:
            raise SolFailed(f"Finding {i} in Sol's sol-findings block has no id.")
        if g['tag'] not in TAGS:
            raise SolFailed(f'Finding {g["id"]} has tag "{f.get("tag")}", not one of '
                            f'{", ".join(TAGS)}.')
        if any(h['id'] == g['id'] for h in found):
            raise SolFailed(f'Two findings have the id {g["id"]}.')
        m = re.match(r'L?(\d+)', g['line'])
        g['line'] = int(m[1]) if m and int(m[1]) > 0 else None
        found.append(g)
    return found, FENCE.sub('', reply).strip()


def parse_earlier(reply: str) -> dict[str, str]:
    """The status Sol gave each earlier finding, from the block's "earlier" list: {id: status}."""
    data = _block(reply)
    items = data.get('earlier') if isinstance(data, dict) else None
    if items is None:
        return {}
    if not isinstance(items, list) or not all(isinstance(e, dict) for e in items):
        raise SolFailed("Sol's sol-findings block has an \"earlier\" that isn't a list of objects.")
    given = {}
    for i, e in enumerate(items, 1):
        fid = _text(e.get('id'))
        s = re.sub(r'[\s_]+', '-', _text(e.get('status')).lower())
        s = {'still-open': 'open', 'decline-kept-open': 'decline-kept'}.get(s, s)
        if not fid:
            raise SolFailed(f'Entry {i} in the block\'s "earlier" list has no id.')
        if s not in STATUSES:
            raise SolFailed(f'Earlier finding {fid} has status "{e.get("status")}", not one of '
                            f'{", ".join(STATUSES)}.')
        if fid in given:
            raise SolFailed(f'Earlier finding {fid} has two statuses.')
        given[fid] = s
    return given


def _root(p: str) -> str:
    return re.escape(str(p).replace('\\', '/')).replace('/', r'[/\\]') + r'[/\\]'


def repo_path(file: str, line, roots=()) -> tuple[str, int | None]:
    """A finding's file as a repo-relative path, and its line if Sol put it on the path."""
    file = re.sub(r'^/(?=[A-Za-z]:)', '', file.replace('\\', '/'))
    for r in roots:
        file = re.sub('^' + _root(r), '', file, flags=re.I)
    m = re.fullmatch(r'(.+?):L?(\d+)(?:-\d+)?', file)
    if m:
        file, line = m[1], line or int(m[2])
    return file, line


def evidence(f: dict) -> bool:
    """What an Important finding needs to block: file and line, and a scenario or a cost and rule."""
    return bool(f['file'] and f['line'] and (f['scenario'] or (f['cost'] and f['rule'])))


# --- the comment ------------------------------------------------------------------------------------

def _cell(s: str) -> str:
    return str(s).replace('|', r'\|').replace('\r', '').replace('\n', ' ')


def _where(repo: str, sha: str, f: dict) -> str:
    if not f['file']:
        return ''
    at = f"{f['file']}:{f['line']}" if f['line'] else f['file']
    return (f"[`{_cell(at)}`](https://github.com/{repo}/blob/{sha}/{urllib.parse.quote(f['file'])}"
            + (f"#L{f['line']})" if f['line'] else ')'))


def github_links(text: str, wt: str, rundir: str, repo: str, sha: str) -> str:
    """Sol cites local paths. On GitHub a link into the checkout points at H; a link into the run
    folder (the diff, the issue) becomes its plain text; bare paths lose the prefix."""
    def to_head(m):
        path = m[2].replace('\\', '/')
        return f'[{m[1]}](https://github.com/{repo}/blob/{sha}/{path}' + (
            f'#L{m[3]})' if m[3] else ')')
    text = re.sub(r'\[([^\]]*)\]\(' + _root(wt) + r'([^):]+)(?::(\d+))?\)', to_head, text,
                  flags=re.I)
    text = re.sub(r'\[([^\]]*)\]\(' + _root(rundir) + r'[^)]*\)', r'\1', text, flags=re.I)
    return re.sub(_root(wt) + '|' + _root(rundir), '', text, flags=re.I)


def mark(rnd: int, verdict: str, sha: str, findings: list[dict]) -> str:
    data = base64.b64encode(json.dumps(findings, separators=(',', ':'), ensure_ascii=False)
                            .encode('utf-8')).decode()
    return f'<!-- sol-pr-review round={rnd} verdict={verdict} sha={sha} findings={data} -->'


def ledger_block(rnd: int, verdict: str, sha: str, findings: list[dict]) -> str:
    data = {'round': rnd, 'head': sha, 'verdict': verdict, 'findings': findings}
    return '```sol-findings\n' + json.dumps(data, indent=1, ensure_ascii=False) + '\n```'


def issue_title(f: dict) -> str:
    t = f['class'] or f['scenario'] or f['cost'] or 'Pre-existing problem'
    t = t[:90] + ('…' if len(t) > 90 else '')
    return f"{t} ({f['file']})" if f['file'] else t


# --- decide ---------------------------------------------------------------------------------------

def decide(repo: str, n: int, sha: str, rnd: int, earlier: list[dict], has_review_md: bool,
           reply: str, wt: str | None = None, rundir: str | None = None,
           gone: bool = False) -> dict:
    """Everything a review decides, from the PR's earlier reviews (read_reviews()) and Sol's reply.
    wt and rundir are the local folders Sol's paths start with; gone means the last reviewed commit
    isn't in H's history (a force-push), so Sol read the whole diff.

    Returns verdict (clean or blocking), outcome (stop, approach-note, merge or fix), signals (why
    it stops: [{signal, ids, text}]), findings (the PR's whole state, as the ledger holds it), kept
    (declines Sol kept), unaddressed (earlier open findings Sol gave no status), status (for
    `sol-review` on H), issues (new Pre-existing findings to file) and body (the comment).
    An unreadable reply raises SolFailed."""
    found, prose = parse_findings(reply)
    given = parse_earlier(reply)
    notes = []
    last = earlier[-1]['sha'] if earlier else None
    if gone:
        notes.append(f'The last reviewed commit{f", {last[:7]}," if last else ""} isn\'t in this '
                     "branch's history any more (a force-push), so this review read the PR's "
                     'whole diff, not only the change since.')
    for f in found:
        f['file'], f['line'] = repo_path(f['file'], f['line'], [r for r in (wt, rundir) if r])
        if f['tag'] == 'important' and not evidence(f):
            f['tag'], f['was'] = 'nit', 'important'
    if down := [f['id'] for f in found if f.get('was')]:
        one = len(down) == 1
        notes.append(f'{", ".join(down)} {"was" if one else "were"} tagged Important without a '
                     'file and line plus a failure scenario, or a later cost and the rule it '
                     f'breaks, so {"it counts" if one else "they count"} as a nit.')
    # An unchanged finding isn't reposted as new: one Sol gives a new ID with the same tag,
    # class, file and line as a finding still open (or filed), and gave no status, is that
    # finding.
    prior = state(earlier)
    ids = {f['id'] for f in found}
    same = []
    for f in found:
        if any(p['id'] == f['id'] for p in prior):
            continue
        p = next((p for p in prior if p['status'] in (*OPEN, 'filed') and p['id'] not in ids
                  and p['id'] not in given
                  and p['tag'] == f['tag'] and norm(p['class']) and p['file']
                  and (norm(p['class']), p['file'], p['line'])
                  == (norm(f['class']), f['file'], f['line'])), None)
        if p:
            same.append(f"{f['id']} is {p['id']}")
            ids.add(p['id'])
            f['id'] = p['id']
    if same:
        notes.append('Listed again under a new ID, with the same tag, class, file and line, so '
                     f'each keeps its earlier ID: {"; ".join(same)}.')
    if over := [f['id'] for f in found if f['tag'] == 'nit'][MAX_NITS:]:
        found = [f for f in found if f['id'] not in over]
        notes.append(f'Nits past the first {MAX_NITS} are left out: {", ".join(over)}.')
    # Filed already: every earlier Pre-existing finding but one whose filing failed (`unfiled`).
    filed = {f.get('id') for m in earlier for f in m['findings']
             if isinstance(f, dict) and f.get('tag') == 'pre-existing' and not f.get('unfiled')}
    pre = [f for f in found if f['tag'] == 'pre-existing']
    if again := [f['id'] for f in pre if f['id'] in filed]:
        notes.append(f'Already filed after an earlier review, so not filed again: '
                     f'{", ".join(again)}.')

    # Carry the state forward. A finding Sol lists again takes its earlier ID's place, open (or
    # filed); one that had closed is reopened. Every other earlier open finding takes the status
    # Sol gave it, and stays as it was if Sol gave none. Closed ones are kept as they are.
    before, new = {f['id']: f for f in prior}, {f['id']: f for f in found}
    for f in found:
        p = before.get(f['id'])
        f['status'] = 'filed' if f['tag'] == 'pre-existing' else 'open'
        f['raised'] = p['raised'] if p else rnd
        if p and p.get('issue'):   # its follow-up issue's URL stays recorded
            f['issue'] = p['issue']
        if p and p['status'] in ('fixed', 'decline-accepted'):
            f['reopened'] = p['status']
    asked = [f['id'] for f in prior if f['status'] in OPEN and f['id'] not in new]
    unaddressed = [i for i in asked if i not in given]
    rows, now = [], []
    for p in prior:
        if p['id'] in new:
            now.append(new[p['id']])
            if p['status'] in (*OPEN, 'filed'):   # listed again: shown with the earlier ones
                rows.append({**new[p['id']], 'again': True})
            continue
        q = dict(p)
        if p['id'] in asked:
            if p['id'] in given:
                q['status'] = given[p['id']]
                if q['status'] not in OPEN:
                    q['closed'] = rnd
            rows.append(q)
        now.append(q)
    now += [f for f in found if f['id'] not in before]
    kept = [f['id'] for f in rows if f['id'] in given and f['status'] == 'decline-kept']
    back = [f for f in found if f.get('reopened')]
    if back:
        notes.append('Raised again after closing in an earlier review: ' + ', '.join(
            f"{f['id']} ({STATUSES[f['reopened']].lower()} in review "
            f"{before[f['id']].get('closed', '?')})" for f in back) + '.')
    if unaddressed:
        one = len(unaddressed) == 1
        notes.append(f"Sol didn't address {', '.join(unaddressed)}: it gave no status, so "
                     f'{"it stays" if one else "they stay"} open.')
    if stray := [i for i in given if i not in asked]:
        notes.append(f'Statuses for {", ".join(stray)} were ignored: not an earlier open finding, '
                     'or listed again as a finding.')

    important = [f['id'] for f in now if f['tag'] == 'important' and f['status'] in OPEN]
    verdict = 'blocking' if important else 'clean'

    # The outcome, in order: stop on any signal; the approach note from review 3 if still
    # blocking; merge if clean; fix otherwise.
    seen = {}
    for p in prior:
        if p['tag'] == 'important' and norm(p['class']):
            seen.setdefault(norm(p['class']), p)
    signals = []
    if rep := [(f, seen[norm(f['class'])]) for f in found
               if f['id'] not in before and f['tag'] == 'important' and norm(f['class']) in seen]:
        signals.append({'signal': 'repeated-class', 'ids': [f['id'] for f, _ in rep],
                        'text': '; '.join(f'{f["id"]} repeats the class "{p["class"]}" of '
                                          f'{p["id"]}, raised in review {p["raised"]}'
                                          for f, p in rep)})
    if back:
        signals.append({'signal': 'reopened', 'ids': [f['id'] for f in back], 'text': '; '.join(
            f'{f["id"]} came back after it was {STATUSES[f["reopened"]].lower()} in review '
            f'{before[f["id"]].get("closed", "?")}' for f in back)})
    if kept:
        signals.append({'signal': 'decline-kept', 'ids': kept,
                        'text': f'Sol kept the decline of {", ".join(kept)} open'})
    outcome = ('stop' if signals else 'approach-note' if important and rnd >= APPROACH_REVIEW
               else 'fix' if important else 'merge')
    notes.append('**Next:** ' + {
        'stop': 'the loop stops here for Stefan: ' + '; '.join(s['text'] for s in signals) + '.',
        'approach-note': f'review {rnd} is still blocking, so an approach note goes to Stefan '
                         'instead of a fix round.',
        'merge': f"the PR merges once its checks pass on {sha[:7]}.",
        'fix': "back to a fix round: fix every case of each Important finding's class, or "
               "decline it with the test that wouldn't fail."}[outcome])

    nits = sum(f['tag'] == 'nit' and f['status'] in OPEN for f in now)
    desc = (f'Blocking: {len(important)} Important finding{"s" * (len(important) != 1)} '
            f'({", ".join(important)})' if important else
            f'Clean: no Important finding, {nits} nit{"s" * (nits != 1)}')
    fresh = [f for f in found if not (f['id'] in before
                                      and before[f['id']]['status'] in (*OPEN, 'filed'))]
    table = (('No new findings.' if earlier else 'No findings.') if not fresh else
             '| ID | Tag | Class | Where |\n|---|---|---|---|\n' + ''.join(
                 f"| {_cell(f['id'])} | {TAGS[f['tag']]} | {_cell(f['class'])} | "
                 f"{_where(repo, sha, f)} |\n" for f in fresh))

    def label(f):
        if f.get('again'):
            return ('Filed already' if f['status'] == 'filed' else 'Still open') + \
                ' (listed again)'
        return STATUSES[f['status']] + ('' if f['id'] in given else ' (Sol gave no status)')
    old = '' if not rows else (
        '### Earlier findings\n\n| ID | Tag | Class | Where | Now |\n|---|---|---|---|---|\n'
        + ''.join(f"| {_cell(f['id'])} | {TAGS[f['tag']]} | {_cell(f['class'])} | "
                  f"{_where(repo, sha, f)} | {label(f)} |\n" for f in rows) + '\n')
    guide = ", with the repo's REVIEW.md" if has_review_md else ''
    scope = f', the change since {last[:7]}' if last and not gone else ''
    text = github_links(prose, wt, rundir, repo, sha) if wt and rundir else prose
    body = (f'## Sol review {rnd} · {verdict.capitalize()}\n\n'
            f'<sub>GPT-6.1 Sol at effort high, read-only, on {sha[:7]}{scope}{guide}. Posted by '
            "the queue runner from Stefan's PC.</sub>\n\n"
            f'{text}\n\n{old}### Findings\n\n{table.rstrip()}\n\n'
            + ''.join(f'{s}\n\n' for s in notes)
            + _trailer(rnd, verdict, sha, now))
    return {'round': rnd, 'sha': sha, 'verdict': verdict, 'outcome': outcome, 'signals': signals,
            'findings': now,
            'kept': kept, 'unaddressed': unaddressed,
            'status': {'state': 'failure' if important else 'success',
                       'description': desc[:140]},
            # New ones, and earlier ones whose filing failed that Sol didn't list again.
            'issues': [{'id': f['id'], 'title': issue_title(f), 'finding': f}
                       for f in [*(f for f in pre if f['id'] not in filed),
                                 *(f for f in now if f.get('unfiled') and f['id'] not in new)]],
            'body': body}


def _trailer(rnd: int, verdict: str, sha: str, findings: list[dict]) -> str:
    """The end of a review comment: the collapsed ledger, then the hidden marker."""
    return (f'{LEDGER}\n\n' + ledger_block(rnd, verdict, sha, findings) + '\n\n</details>\n\n'
            + mark(rnd, verdict, sha, findings) + '\n')


def with_issues(d: dict, urls: dict[str, str], failed=()) -> str:
    """The comment with each filed Pre-existing finding's issue linked ({finding id: url}) and
    its URL recorded in the ledger and the marker (`issue`), so no later review files it again.
    One whose filing `failed` is marked `unfiled`, so the next review files it."""
    if not urls and not failed:
        return d['body']
    for f in d['findings']:
        if f['id'] in urls:
            f['issue'] = urls[f['id']]
            f.pop('unfiled', None)
        elif f['id'] in failed:
            f['unfiled'] = True
    said = ''
    if urls:
        said += 'Filed as follow-up issues: ' + ', '.join(
            f'{fid} → [#{url.rstrip("/").rsplit("/", 1)[-1]}]({url})'
            for fid, url in urls.items()) + '.\n\n'
    if failed:
        one = len(failed) == 1
        said += (f'Filing {", ".join(failed)} as {"a follow-up issue" if one else "follow-up issues"}'
                 f' failed; the next review files {"it" if one else "them"}.\n\n')
    body = d['body']
    return (body[:body.rindex(LEDGER)] + said
            + _trailer(d['round'], d['verdict'], d['sha'], d['findings']))
