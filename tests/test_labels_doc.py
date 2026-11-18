"""Issue #176: every label the runner reads or applies is named in `docs/flow.md`, Labels. The
names are collected from where a label is used, not from a list kept beside them: each
`add_label`/`remove_label` call, each `create_issue` label list, each `in x.labels` check, each
label query in a GitHub call, and the labels the app creates in a served repo."""
import ast
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE = os.path.join(ROOT, 'queue_runner')
# A label inside a query string: REST `labels=x&`, GraphQL `labels: ["x"]` (not `labels=tuple(`).
QUERY = re.compile(r'labels(?:=|:\s*\[\s*")([a-z][a-z-]*)(?=[&"\'])')


def _constants(tree) -> dict:
    out = {}
    for node in tree.body:
        if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out[t.id] = node.value.value
    return out


def _names(node, consts, where) -> set:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return {node.value}
    if isinstance(node, ast.Name) and node.id in consts:
        return {consts[node.id]}
    if isinstance(node, (ast.List, ast.Tuple)):
        return set().union(*(_names(e, consts, where) for e in node.elts)) if node.elts else set()
    raise AssertionError(f'{where}: a label the test can\'t name ({ast.dump(node)[:80]})')


def python_labels() -> dict:
    """{label: [file:line, ...]} for every label the Python runner applies, removes or reads."""
    found = {}

    def add(names, where):
        for n in names:
            found.setdefault(n, []).append(where)

    for name in sorted(os.listdir(PACKAGE)):
        if not name.endswith('.py'):
            continue
        path = os.path.join(PACKAGE, name)
        with open(path, encoding='utf-8') as f:
            text = f.read()
        tree = ast.parse(text)
        consts = _constants(tree)
        for node in ast.walk(tree):
            where = f'{name}:{getattr(node, "lineno", "?")}'
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                fn, args = node.func.attr, node.args
                if fn in ('add_label', 'remove_label') and len(args) >= 3:
                    add(_names(args[2], consts, where), where)
                elif fn == 'create_issue':
                    label_args = args[3:4] + [k.value for k in node.keywords if k.arg == 'labels']
                    for a in label_args:
                        add(_names(a, consts, where), where)
            elif isinstance(node, ast.Compare) and len(node.ops) == 1 \
                    and isinstance(node.ops[0], (ast.In, ast.NotIn)) \
                    and isinstance(node.comparators[0], ast.Attribute) \
                    and node.comparators[0].attr == 'labels':
                add(_names(node.left, consts, where), where)
        for n, line in enumerate(text.splitlines(), 1):
            for m in QUERY.finditer(line):
                add({m.group(1)}, f'{name}:{n}')
    return found


def app_labels() -> set:
    """The labels the app creates in a repo it serves (`RUNNER_LABELS`, app/src/repos.ts)."""
    with open(os.path.join(ROOT, 'app', 'src', 'repos.ts'), encoding='utf-8') as f:
        text = f.read()
    block = re.search(r'RUNNER_LABELS[^=]*=\s*\[(.*?)\];', text, re.S).group(1)
    return set(re.findall(r"name:\s*'([^']+)'", block))


def documented() -> set:
    with open(os.path.join(ROOT, 'docs', 'flow.md'), encoding='utf-8') as f:
        text = f.read()
    section = re.search(r'^## Labels\n(.*?)(?=^## )', text, re.S | re.M).group(1)
    return set(re.findall(r'^- `([^`]+)`', section, re.M))


class LabelsDocTest(unittest.TestCase):
    def test_finds_the_labels_it_knows_the_runner_uses(self):
        # A guard on the collector itself: each of these is applied or read at a known site.
        found = python_labels()
        for label in ('ready-for-agent', 'needs-info', 'needs-triage', 'ready-for-stefan'):
            self.assertIn(label, found)
        self.assertIn('ready-to-merge', app_labels())

    def test_every_label_the_runner_uses_is_in_the_labels_section(self):
        used = set(python_labels()) | app_labels()
        self.assertEqual(sorted(used - documented()), [], 'add these to docs/flow.md, Labels')

    def test_the_labels_section_names_no_label_the_runner_doesnt_use(self):
        used = set(python_labels()) | app_labels()
        self.assertEqual(sorted(documented() - used), [], 'nothing applies or reads these')


if __name__ == '__main__':
    unittest.main()
