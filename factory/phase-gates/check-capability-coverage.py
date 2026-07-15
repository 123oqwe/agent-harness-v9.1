#!/usr/bin/env python3
import json; d=json.load(open('requirements/capability-coverage.json')); print(f'PASS' if d['unmapped']==0 else f'FAIL: {d["unmapped"]} unmapped')
