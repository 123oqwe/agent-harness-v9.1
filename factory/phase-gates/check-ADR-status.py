#!/usr/bin/env python3
import os; nv=sum(1 for f in os.listdir('adr') if 'NEEDS_VERIFICATION' in open(f'adr/{{}}'.format(f)).read()); print(f'PASS: {nv} NEEDS_VERIFICATION' if nv==0 else f'FAIL: {nv} still NEEDS_VERIFICATION')
