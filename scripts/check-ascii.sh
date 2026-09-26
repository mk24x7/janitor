#!/bin/bash
# Fail if any tracked (or untracked but not ignored) file contains a
# non-ASCII byte. Uses perl because BSD grep has no -P.
set -euo pipefail

cd "$(dirname "$0")/.."

status=0
while IFS= read -r -d '' file; do
    [ -f "$file" ] || continue
    if ! perl -ne '
        if (/[^\x00-\x7F]/) {
            my $col = $-[0] + 1;
            print "$ARGV:$.:$col: non-ASCII byte\n";
            $bad = 1;
        }
        END { exit($bad ? 1 : 0) }
    ' "$file"; then
        status=1
    fi
done < <(git ls-files -z --cached --others --exclude-standard)

if [ "$status" -ne 0 ]; then
    echo "error: non-ASCII bytes found (see above)" >&2
    exit 1
fi
echo "All files are pure ASCII."
