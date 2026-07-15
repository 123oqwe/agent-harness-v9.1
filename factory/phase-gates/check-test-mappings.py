#!/usr/bin/env python3
import json; reqs=[json.loads(l) for l in open('requirements/requirements.ndjson') if l.strip()]; no_test=[r['id'] for r in reqs if not r.get('test_files')]; print(f'PASS: all {len(reqs)} have tests' if not no_test else f'FAIL: {no_test[:5]}')
