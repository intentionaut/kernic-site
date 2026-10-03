"""Both directions for every check: what must pass is written first.

Runs the script against throwaway git repos. Terms here are invented words,
never real private terms.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "public-notes-check.py"
TERMS = "Zorblatt\nQuexley Partners\nTUI\n"
OLD_LOG = "# Changelog\n\n## 0.1.0\n\n- a\n- b\n- c\n- d\n- e\n- f\n\nOld contact: someone@oldcorp.io\n"


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"})


class Case(unittest.TestCase):
    def run_check(self, files, title="Exports finish on large projects", body="What changes: exports complete.",
                  terms=TERMS, flags=(), allow=None):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            git(d, "init", "-q", "-b", "main")
            (d / "CHANGELOG.md").write_text(OLD_LOG)
            (d / "README.md").write_text("# Thing\n")
            if allow:
                (d / ".piiallow").write_text(allow)
            git(d, "add", "-A"); git(d, "commit", "-q", "-m", "base")
            git(d, "checkout", "-q", "-b", "change")
            for name, text in files.items():
                (d / name).parent.mkdir(parents=True, exist_ok=True)
                (d / name).write_text(text)
            git(d, "add", "-A"); git(d, "commit", "-q", "-m", "change", "--allow-empty")
            env = {**os.environ, "PR_TITLE": title, "PR_BODY": body, "PRIVATE_TERMS": terms}
            r = subprocess.run([sys.executable, str(SCRIPT), "--base", "main", *flags], cwd=d,
                               capture_output=True, text=True, env=env)
            return r.returncode, r.stdout + r.stderr

    # --- what must pass ---------------------------------------------------

    def test_clean_change_passes(self):
        code, out = self.run_check({"README.md": "# Thing\n\nNow with exports.\n"})
        self.assertEqual((0, "clean"), (code, out.strip()))

    def test_safe_addresses_pass(self):
        text = "# Thing\nCo-Authored-By: A <noreply@anthropic.com>\ngit clone git@github.com:o/r.git\nnpm i pkg@1.2.3\nuses: actions/checkout@v6\nmail hello@example.com\n"
        self.assertEqual(0, self.run_check({"README.md": text})[0])

    def test_word_that_contains_a_term_passes(self):
        self.assertEqual(0, self.run_check({"README.md": "# Thing\nAn intuitive export.\n"})[0])

    def test_untouched_old_lines_pass(self):
        # The base changelog holds an address and a six-bullet entry. Neither is added here.
        self.assertEqual(0, self.run_check({"README.md": "# Thing\nMore.\n"})[0])

    def test_allowlisted_pattern_passes(self):
        code, _ = self.run_check({"README.md": "# Thing\nWrite to press@thing.dev\n"}, allow="# published\npress@thing\\.dev\n")
        self.assertEqual(0, code)

    def test_private_session_link_passes(self):
        self.assertEqual(0, self.run_check({}, body="Done.\n\nhttps://claude.ai/code/session_0123")[0])

    def test_placeholder_address_passes(self):
        self.assertEqual(0, self.run_check({"src/copy.ts": 'placeholder: "you@company.com"\n'})[0])

    def test_quiet_release_passes(self):
        log = OLD_LOG.replace("## 0.1.0", "## 0.2.0\n\nBug fixes and updates.\n\n## 0.1.0")
        self.assertEqual(0, self.run_check({"CHANGELOG.md": log})[0])

    def test_five_bullets_pass(self):
        new = "## 0.2.0\n\n" + "".join("- **Lead %d.** Text.\n" % i for i in range(5)) + "\n## 0.1.0"
        self.assertEqual(0, self.run_check({"CHANGELOG.md": OLD_LOG.replace("## 0.1.0", new)})[0])

    def test_em_dash_in_code_is_not_this_checks_business(self):
        self.assertEqual(0, self.run_check({"src/a.py": "x = 'a — b'\n"})[0])

    def test_lockfile_is_skipped(self):
        self.assertEqual(0, self.run_check({"package-lock.json": '{"author": "dev@somewhere.io"}\n'})[0])

    def test_missing_terms_is_said_out_loud(self):
        code, out = self.run_check({"README.md": "# Thing\nMore.\n"}, terms="")
        self.assertEqual(0, code)
        self.assertIn("terms: NOT CHECKED", out)

    # --- what must be refused ----------------------------------------------

    def test_email_in_added_line_is_refused(self):
        code, out = self.run_check({"README.md": "# Thing\nAsk jo.bloggs@realcorp.io\n"})
        self.assertEqual(1, code); self.assertIn("pii: README.md:2", out)

    def test_phone_in_description_is_refused(self):
        code, out = self.run_check({}, body="Call +44 20 7946 0000 with questions.")
        self.assertEqual(1, code); self.assertIn("pii: PR description line 1", out)

    def test_private_key_is_refused(self):
        code, out = self.run_check({"k.txt": "-----BEGIN OPENSSH PRIVATE KEY-----\n"})
        self.assertEqual(1, code); self.assertIn("pii: k.txt:1", out)

    def test_term_in_title_is_refused_without_naming_it(self):
        code, out = self.run_check({}, title="Tidy the zorblatt importer")
        self.assertEqual(1, code); self.assertIn("terms: PR title", out)
        self.assertNotIn("orblatt", out.lower().replace("terms: pr title", ""))

    def test_short_term_as_a_whole_word_is_refused(self):
        code, out = self.run_check({"README.md": "# Thing\nBuilt for TUI.\n"})
        self.assertEqual(1, code); self.assertIn("terms: README.md:2", out)

    def test_two_word_term_is_refused(self):
        self.assertEqual(1, self.run_check({"docs/a.md": "For Quexley Partners.\n"})[0])

    def test_shared_session_link_in_description_is_refused(self):
        code, out = self.run_check({}, body="Done.\n\nhttps://claude.ai/share/0123")
        self.assertEqual(1, code); self.assertIn("traces: PR description line 3", out)

    def test_shared_session_link_in_a_file_is_refused(self):
        self.assertEqual(1, self.run_check({"README.md": "# Thing\nSee https://opencode.ai/s/abc123\n"})[0])

    def test_em_dash_in_title_is_refused(self):
        code, out = self.run_check({}, title="Exports — now faster")
        self.assertEqual(1, code); self.assertIn("dashes: PR title", out)

    def test_em_dash_in_changelog_is_refused(self):
        log = OLD_LOG.replace("## 0.1.0", "## 0.2.0\n\n- **Exports.** Faster — much.\n\n## 0.1.0")
        code, out = self.run_check({"CHANGELOG.md": log})
        self.assertEqual(1, code); self.assertIn("dashes: CHANGELOG.md:5", out)

    def test_six_bullets_in_a_new_entry_are_refused(self):
        new = "## 0.2.0\n\n" + "".join("- **Lead %d.** Text.\n" % i for i in range(6)) + "\n## 0.1.0"
        code, out = self.run_check({"CHANGELOG.md": OLD_LOG.replace("## 0.1.0", new)})
        self.assertEqual(1, code); self.assertIn("shape: CHANGELOG.md:3 has 6 bullets", out)

    def test_required_terms_missing_cannot_run(self):
        code, out = self.run_check({"README.md": "# Thing\nMore.\n"}, terms="", flags=("--require-terms",))
        self.assertEqual(2, code); self.assertIn("could not run", out)

    def test_bad_base_cannot_run(self):
        with tempfile.TemporaryDirectory() as d:
            git(d, "init", "-q", "-b", "main")
            r = subprocess.run([sys.executable, str(SCRIPT), "--base", "nope"], cwd=d, capture_output=True, text=True,
                               env={**os.environ, "PRIVATE_TERMS": TERMS})
            self.assertEqual(2, r.returncode)


if __name__ == "__main__":
    unittest.main()
