#!/usr/bin/env python3
"""`just repin <sha>`: move the deck to one Jesssullivan/adi-sms commit (stdlib only).

Contract: docs/content-contract.md, "Re-pinning". `pin` runs every step:

  1. check the sha (40 hex digits, a commit on GitHub) and find the one old pin in the ::src chips;
  2. map every pinned line range from the old commit to the new one, in a cached clone (.cache/adi-sms):
     ::src chip #Lx-Ly and "<file> line(s) N" citations in the notes (<notes-dir>/NN.md, with --notes-dir).
     A range whose lines are unchanged moves silently; one whose text changed is moved by the nearest
     unchanged line and printed under CHECK, with every bare "line N" citation in a note;
  3. replace the old sha, full and short forms, in content/sections and the notes;
  4. just deck, then just check (the style rubric there is advisory);
  5. print the ranges that moved, the citations to check by hand and the timings.

The code fences on the slides are not refetched: a chip under CHECK marks a fence to update by hand. A second
run is a no-op rewrite.
Flags: --no-check (skip `just check`), --dry-run (print the rewrites, write nothing), --notes-dir <dir> (the notes
directory outside this repo; without it the notes are left alone).
"""

import argparse, difflib, os, re, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = "Jesssullivan/adi-sms"
CONTENT = ROOT / "content"
CLONE = Path(os.environ.get("ADI_SMS_CLONE", ROOT / ".cache/adi-sms"))
SHA = re.compile(r"^[0-9a-f]{40}$")
CHIP = re.compile(r'(::src\{ref=")' + re.escape(REPO) + r'@([0-9a-f]{40}):([^"#]+)(?:#L(\d+)(?:-L(\d+))?)?(")')
CITE = re.compile(r"(?P<file>[\w./-]+\.(?:py|md|hs|dhall|ya?ml|nix|json|rs|js|toml|args))(?P<gap>'s)?\s+"
                  r"(?P<kw>[Ll]ines?)\s+(?P<nums>\d+(?:\s*(?:,|and|to)\s*\d+)*)")
BARE = re.compile(r"(?<![\w./-])(?P<kw>[Ll]ines?)\s+(?P<nums>\d+(?:\s*(?:,|and|to)\s*\d+)*)")


def git(*args):
    return subprocess.run(["git", "-C", str(CLONE), *args], check=True, capture_output=True, text=True).stdout


def have(sha):
    r = subprocess.run(["git", "-C", str(CLONE), "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True)
    return r.returncode == 0


def ensure_clone(*shas):
    if not (CLONE / ".git").exists():
        CLONE.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "-q", f"https://github.com/{REPO}", str(CLONE)], check=True)
    if not all(have(s) for s in shas):
        git("fetch", "-q", "origin")
    if missing := [s for s in shas if not have(s)]:
        sys.exit(f"repin: {', '.join(missing)} not in {REPO}")


def check_sha(sha):
    if not SHA.match(sha):
        sys.exit(f"repin: {sha!r} is not a full 40-character lowercase sha")
    r = subprocess.run(["gh", "api", f"repos/{REPO}/commits/{sha}", "-q", ".sha"], capture_output=True, text=True)
    if r.returncode or r.stdout.strip() != sha:
        sys.exit(f"repin: {sha} is not a commit of {REPO} on GitHub: {r.stderr.strip()}")


class Files:
    """One path at the old and the new sha, and the map of unchanged lines between them (1-based)."""

    def __init__(self, old, new):
        self.old, self.new, self.cache = old, new, {}
        self.paths = git("ls-tree", "-r", "--name-only", old).split()

    def get(self, path):
        if path not in self.cache:
            show = lambda s: subprocess.run(["git", "-C", str(CLONE), "show", f"{s}:{path}"], capture_output=True,
                                            text=True).stdout.split("\n")
            a, b = show(self.old), show(self.new)
            m = {}
            for tag, i1, i2, j1, _ in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
                if tag == "equal":
                    m.update({i1 + k + 1: j1 + k + 1 for k in range(i2 - i1)})
            self.cache[path] = (a, b, m)
        return self.cache[path]

    def resolve(self, name):  # a cited file name to its path at the old sha, or None if unknown or ambiguous
        if name in self.paths:
            return name
        hits = [p for p in self.paths if p.endswith("/" + name)]
        return hits[0] if len(hits) == 1 else None

    def estimate(self, path, n):  # n's new number: exact if unchanged, else offset from the nearest unchanged line
        a, b, m = self.get(path)
        if n in m:
            return m[n]
        below = [k for k in m if k < n]
        k = max(below) if below else None
        return max(1, min(len(b), (m[k] + n - k) if k else n))

    def span(self, path, a, z):  # (new a, new z, status): same, moved, changed
        old, new, m = self.get(path)
        if a in m and all(m.get(k) == m[a] + k - a for k in range(a, z + 1)):
            return m[a], m[a] + z - a, "same" if m[a] == a else "moved"
        seg, n = old[a - 1:z], z - a + 1
        hits = [i + 1 for i in range(len(new) - n + 1) if new[i:i + n] == seg]
        if len(hits) == 1:
            return hits[0], hits[0] + n - 1, "same" if hits[0] == a else "moved"
        return self.estimate(path, a), self.estimate(path, z), "changed"


def replace_short(text, old, new):
    pat = re.compile(r"(?<![0-9a-f])" + old[:7] + r"[0-9a-f]{0,33}(?![0-9a-f])")
    sub = lambda mo: new[:len(mo.group())] if old.startswith(mo.group()) else mo.group()
    return pat.sub(sub, text)


def old_pin(new):
    pins = {mo.group(2) for f in (CONTENT / "sections").glob("*.md") for mo in CHIP.finditer(f.read_text())}
    pins.discard(new)
    if len(pins) > 1:
        sys.exit(f"repin: more than one old pin in content/: {sorted(pins)}")
    return pins.pop() if pins else None


def rewrite_cites(text, files, report, where):
    """Map "<file> line(s) N" citations in a note; a bare "line N" names no file, so it goes under CHECK."""

    def renumber(path, nums, label):
        name = label if label in (path, "Line", "Lines", "line", "lines") else f"{label} ({path})"
        parts = re.split(r"(\d+)", nums)
        olds = [int(p) for p in parts[1::2]]
        ranges = [(olds[i], olds[i + 1]) for i, p in enumerate(parts[2:-1:2]) if p.strip() == "to"]
        new = [files.get(path)[2].get(n) for n in olds]
        if any(v is None for v in new) or any(files.span(path, a, z)[2] == "changed" for a, z in ranges):
            guess = [files.estimate(path, n) for n in olds]
            report["check"].append(f"{where}: {name} {nums} in {path}: text changed; nearest unchanged gives {guess}")
            return nums
        if new != olds:
            report["moved"].append(f"{where}: {name} {nums} in {path} -> {new}")
        parts[1::2] = [str(n) for n in new]
        return "".join(parts)

    def cite(mo):
        path = files.resolve(mo["file"])
        if not path:
            return mo.group()
        return mo.group()[: mo.start("nums") - mo.start()] + renumber(path, mo["nums"], mo["file"])

    def bare(mo):
        report["check"].append(f"{where}: {mo['kw']} {mo['nums']}: a bare citation; check it against the slide")
        return mo.group()

    out = []
    for line in text.split("\n"):
        cites = [(mo.start("kw"), mo.end()) for mo in CITE.finditer(line)]  # a file name already names these
        line = BARE.sub(lambda mo: mo.group() if any(a <= mo.start() < z for a, z in cites) else bare(mo), line)
        out.append(CITE.sub(cite, line))
    return "\n".join(out)


def rewrite_sections(files, old, new, report, dry, notes_dir):
    for f in sorted((CONTENT / "sections").glob("*.md")):
        text = f.read_text()

        def chip(mo):
            path, a, z = mo.group(3), mo.group(4), mo.group(5)
            if not a:
                return f"{mo.group(1)}{REPO}@{new}:{path}{mo.group(6)}"
            a, z = int(a), int(z or a)
            a2, z2, status = files.span(path, a, z)
            if status == "changed":
                report["check"].append(f"{f.name}: ::src {path}#L{a}-L{z}: text changed; nearest unchanged gives L{a2}-L{z2}")
            elif (a2, z2) != (a, z):
                report["moved"].append(f"{f.name}: ::src {path}#L{a}-L{z} -> L{a2}-L{z2}")
            rng = f"#L{a2}" + (f"-L{z2}" if mo.group(5) else "")
            return f"{mo.group(1)}{REPO}@{new}:{path}{rng}{mo.group(6)}"

        slide = CHIP.sub(lambda mo: chip(mo) if mo.group(2) == old else mo.group(), text)
        rewrites = [(f, replace_short(slide, old, new))]
        note = notes_dir / f"{f.name.split('-')[0]}.md" if notes_dir else None
        if note and note.exists():
            cited = rewrite_cites(note.read_text(), files, report, f"notes/{note.name}")
            rewrites.append((note, replace_short(cited, old, new)))
        for path, text2 in rewrites:
            if text2 != path.read_text() and not dry:
                path.write_text(text2)


def run(step, cmd, timings, **kw):
    print(f"repin: {step}: {' '.join(cmd)}", flush=True)
    t = time.monotonic()
    r = subprocess.run(cmd, cwd=kw.pop("cwd", ROOT), **kw)
    timings.append((step, time.monotonic() - t, r.returncode))
    if r.returncode:
        summary(timings)
        sys.exit(f"repin: {step} failed (exit {r.returncode})")


def summary(timings):
    print("\nrepin: timings")
    for step, s, rc in timings:
        print(f"  {step:<24} {s:7.1f} s{'' if rc == 0 else f'  exit {rc}'}")
    print(f"  {'total':<24} {sum(s for _, s, _ in timings):7.1f} s")


def pin(args):
    t0, timings = time.monotonic(), []
    new = args.sha
    check_sha(new)
    old = old_pin(new)
    ensure_clone(*([new] + ([old] if old else [])))
    timings.append(("check and clone", time.monotonic() - t0, 0))
    report = {"moved": [], "check": []}
    if old:
        print(f"repin: {REPO} {old[:12]} -> {new[:12]}")
        t = time.monotonic()
        rewrite_sections(Files(old, new), old, new, report, args.dry_run, args.notes_dir)
        timings.append(("rewrite pins", time.monotonic() - t, 0))
    else:
        print(f"repin: content/ already pins {new[:12]}; rebuilding")
    if args.dry_run:
        return print_report(report, timings)
    run("deck", ["just", "deck"], timings)
    if not args.no_check:
        run("check", ["just", "check"], timings)
    print_report(report, timings)


def print_report(report, timings):
    for key, title in (("moved", "ranges moved (unchanged text)"), ("check", "CHECK by hand (text changed)")):
        print(f"\nrepin: {title}: {len(report[key])}")
        for line in report[key]:
            print(f"  - {line}")
    summary(timings)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pin")
    p.add_argument("sha")
    p.add_argument("--no-check", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--notes-dir", type=Path)
    args = ap.parse_args()
    pin(args)


if __name__ == "__main__":
    main()
