# Shift inspector — READ ONLY. Inputs: SHIFT_DIRS (newline list), SHIFT_PYS ("interp|user|cwd" lines), SHIFT_NODES (paths), SHIFT_USERS
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
printf '%s\n' "$SHIFT_DIRS" | while IFS= read -r d; do
  [ -n "$d" ] && [ -d "$d" ] || continue
  sz=$(du -sk "$d" 2>/dev/null | awk '{print $1}')
  own=$(ls -ld "$d" 2>/dev/null | awk '{print $3":"$4}')
  ses=$(find "$d" -maxdepth 3 \( -name '*.session' -o -name '*.session-journal' \) -type f 2>/dev/null | head -n 20 | tr '\n' '|')
  venvs=$(find "$d" -maxdepth 3 -name pyvenv.cfg -type f 2>/dev/null | head -n 5 | tr '\n' '|')
  lock=; for l in package-lock.json yarn.lock pnpm-lock.yaml bun.lockb bun.lock poetry.lock Pipfile.lock uv.lock composer.lock; do [ -f "$d/$l" ] && lock="$lock $l"; done
  nm=; [ -d "$d/node_modules" ] && nm=$(du -sk "$d/node_modules" 2>/dev/null | awk '{print $1}')
  envf=; [ -f "$d/.env" ] && envf=1
  out DIR "$d" "${sz:-0}" "$own" "$ses" "$venvs" "$lock" "$envf" "$nm"
  for m in package.json requirements.txt pyproject.toml Pipfile composer.json go.mod Dockerfile; do
    [ -f "$d/$m" ] && printf '@@MF %s %s %s\n' "$(printf '%s' "$d" | base64 | tr -d '\n')" "$(printf '%s' "$m" | base64 | tr -d '\n')" "$(head -c 65536 "$d/$m" | base64 | tr -d '\n')"
  done
done

PYF=/tmp/shift-pyinfo-$$.py
cat > "$PYF" <<'EOF'
import sys, os
print("V=%d.%d.%d" % tuple(sys.version_info[:3]))
print("PREFIX=" + sys.prefix)
print("BASE=" + getattr(sys, "base_prefix", sys.prefix))
print("EXE=" + sys.executable)
try:
    import site
    for p in site.getsitepackages() + [site.getusersitepackages()]:
        print("SITE=" + p)
except Exception:
    pass
try:
    from importlib import metadata as m
    for d in m.distributions():
        try:
            print("PKG=%s==%s|%s" % (d.metadata["Name"], d.version, str(getattr(d, "_path", ""))))
        except Exception:
            pass
except Exception:
    try:
        import pkg_resources
        for d in pkg_resources.working_set:
            print("PKG=%s==%s|%s" % (d.project_name, d.version, d.location))
    except Exception:
        pass
EOF
chmod 644 "$PYF"
printf '%s\n' "$SHIFT_PYS" | while IFS='|' read -r py u cwd; do
  [ -n "$py" ] || continue
  r=$(as_user "${u:-root}" "cd $(q "${cwd:-/}") 2>/dev/null; $(q "$py") $(q "$PYF")" 2>/dev/null)
  out PYINFO "$py" "$u" "$cwd" "$r"
done
rm -f "$PYF"

printf '%s\n' "$SHIFT_NODES" | while IFS= read -r nb; do
  [ -n "$nb" ] && [ -x "$nb" ] || continue
  v=$("$nb" -v 2>/dev/null)
  pfx=$(dirname "$(dirname "$nb")")
  g=
  for p in "$pfx"/lib/node_modules/*/package.json "$pfx"/lib/node_modules/@*/*/package.json; do
    [ -f "$p" ] || continue
    g="$g $(awk -F'"' '!n && /"name":/{n=$4} !v && /"version":/{v=$4} END{print n"@"v}' "$p")"
  done
  out NODEINFO "$nb" "$v" "$pfx" "$g"
done

printf '%s\n' "$SHIFT_USERS" | while IFS= read -r u; do
  [ -n "$u" ] || continue
  h=$(pw_home "$u"); [ -n "$h" ] || continue
  [ -f "$h/.ssh/authorized_keys" ] && outf AUTHKEYS "$u" "$h/.ssh/authorized_keys"
  for f in "$h"/.local/lib/python*/site-packages; do [ -d "$f" ] && out USERSITE "$u" "$f"; done
  [ -d "$h/.nvm" ] && out NVM "$u" "$h/.nvm"
done
for f in /usr/local/lib/python*/dist-packages /usr/local/lib/python*/site-packages; do [ -d "$f" ] && [ -n "$(ls -A "$f" 2>/dev/null)" ] && out LOCALSITE "$f"; done
exit 0
