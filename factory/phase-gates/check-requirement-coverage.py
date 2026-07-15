#!/usr/bin/env python3
import json; reqs=[json.loads(l) for l in open('requirements/requirements.ndjson') if l.strip()]; print(f'PASS: {len(reqs)} requirements') if reqs else print('FAIL')
