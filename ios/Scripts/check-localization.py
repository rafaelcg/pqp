#!/usr/bin/env python3
"""Fail the build when user-facing copy never reached the string catalogue.

WHY THIS IS A BUILD PHASE and not a test. The catalogue is keyed on the English
source string, and the only thing that knows which literals are keys is the
compiler: `SWIFT_EMIT_LOC_STRINGS` makes it write one `.stringsdata` per file
listing every `LocalizedStringKey` and `String(localized:)` it saw. Nothing else
can tell `Text("Hang up")` (copy) from `Text(name)` (a value), and a scanner
that guessed would be a second thing to be wrong about. Those files exist only
inside a build, so this check has to run inside one too.

WHAT IT CATCHES, which is the failure the app already shipped 126 times: a new
English literal that nobody added to `Localizable.xcstrings`. There is no error
and no warning for that anywhere in Xcode. The build succeeds, the tests pass,
`NoEmDashTests.testEveryStringInTheCatalogueIsStillTranslated` passes because it
only reads the catalogue, and a Brazilian user quietly gets English.

WHAT IT DOES NOT CATCH: a translation that exists and is never looked up,
because `Text(someString)` is the *verbatim* initialiser. That one is invisible
to the compiler too. Its symptom is the opposite of this one, a catalogue key
that no `.stringsdata` mentions, and it is deliberately NOT reported here: a
string somebody simply deleted leaves exactly the same trace, and an incremental
build only regenerates the `.stringsdata` of the files it recompiled, so most of
the catalogue would look orphaned on most builds. Checking that direction means
comparing a clean build, which is a thing to do while hunting rather than a
thing to do every time anybody presses Run.
"""
import json
import os
import subprocess
import sys


def stringsdata_keys(directory):
    keys = {}
    if not os.path.isdir(directory):
        return keys
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".stringsdata"):
            continue
        path = os.path.join(directory, name)
        raw = subprocess.run(
            ["plutil", "-convert", "json", "-o", "-", path],
            capture_output=True, check=False,
        )
        if raw.returncode != 0:
            continue
        for entries in (json.loads(raw.stdout).get("tables") or {}).values():
            for entry in entries:
                key = entry.get("key")
                # An empty key is what a `LocalizedStringKey` switch returns for
                # the case with nothing to say. It is not copy.
                if not key:
                    continue
                where = "{}:{}".format(
                    name.replace(".stringsdata", ".swift"),
                    entry.get("location", {}).get("startingLine", "?"),
                )
                keys.setdefault(key, where)
    return keys


def main():
    catalogue_path = sys.argv[1]
    objects_dir = sys.argv[2]

    with open(catalogue_path, encoding="utf-8") as handle:
        catalogue = json.load(handle)["strings"]

    extracted = {}
    for arch in sorted(os.listdir(objects_dir)) if os.path.isdir(objects_dir) else []:
        extracted.update(stringsdata_keys(os.path.join(objects_dir, arch)))

    if not extracted:
        # Nothing to compare against. Almost always SWIFT_EMIT_LOC_STRINGS being
        # off rather than an app with no copy in it, so say which.
        print(
            "warning: no .stringsdata to check localisation against. "
            "Is SWIFT_EMIT_LOC_STRINGS still YES?"
        )
        return 0

    missing = sorted(key for key in extracted if key not in catalogue)
    for key in missing:
        print(
            '{}: error: "{}" is user-facing copy with no entry in '
            "Localizable.xcstrings, so a Brazilian reader gets the English. "
            "Add it with its pt-BR, or use Text(verbatim:) if it is a value "
            "rather than words.".format(extracted[key], key)
        )
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
