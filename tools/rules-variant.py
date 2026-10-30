#!/usr/bin/env python3
"""Make a copy of the rules with some game nodes stubbed out (for finding which node Firebase rejects).
Usage: rules-variant.py keep|drop node1,node2,... [deep.path=stub ...] > out.json"""
import json, sys
d = json.load(open('/home/claude/manhunt/firebase/database.rules.json'))
g = d['rules']['games']['$g']
mode, names = sys.argv[1], [n for n in sys.argv[2].split(',') if n]
always = {'meta', 'players', 'seen', '.validate', '$other'}
for k in list(g):
    if k in always: continue
    if (mode == 'keep' and k not in names) or (mode == 'drop' and k in names):
        g[k] = {'.read': False}
for spec in sys.argv[3:]:
    path, _ = spec.split('=')
    node = g
    parts = path.split('.')
    for p in parts[:-1]: node = node[p]
    node[parts[-1]] = {'.read': False} if not parts[-1].startswith('.') else 'false'
import os
canary = os.environ.get('CANARY')
if canary:
    d['rules']['canary_' + canary] = {'.read': True}
json.dump(d, sys.stdout, indent=1)
