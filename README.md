# Queue runner

A script with no AI in it that runs the build-and-review queue: it picks the next ticket, merges
clean PRs and keeps the review loop moving, and starts fresh T3 Code threads only for work that
needs Claude (builds, fix rounds, decisions) or Sol (reviews).

```
python3 -m queue_runner                       # run: both lanes, pass after pass (unattended: see Running unattended)
python3 -m queue_runner --once                # one pass of each lane: at most one Claude job (a decision, a fix round or a build), merges, at most one Sol review
python3 -m queue_runner --once --dry-run      # print the next Claude job's brief (a job cut off by a usage limit first, then a decision, then a fix round), list the stops it would file, what Sol would review and what would merge
python3 -m queue_runner --release NAME#N      # let the picker take a held issue again (a PR: retry its failed reviews, merges and fix round; let a stopped PR go)
python3 -m queue_runner --review NAME#N       # Sol reviews that PR's head now, if adoption says it needs one
python3 -m queue_runner --gate                # Claude's usage now, and whether a build, fix or decision would start
python3 -m queue_runner --pause | --resume [LANE]   # stop a lane after its job, or let it carry on (claude, sol, all): the dashboard's Stop and Resume
python3 -m queue_runner --reserve PERCENT     # the share of the week kept for Stefan (default 5)
python3 -m queue_runner --stop                # stop the running runner
python3 -m queue_runner --inbox               # everything waiting on Stefan: PRs ready to merge, needs-info stops, threads waiting for his answer
```

Its dashboard is a separate small process (`dashboard/`; AGENTS.md, The dashboard):

```
python3 -m dashboard    # the runner's page on http://queue.localhost:5289/, sample data on http://localhost:5289/
```

The rules, how it runs unattended, the live checks, the tests and everything else are in
[`AGENTS.md`](AGENTS.md).
