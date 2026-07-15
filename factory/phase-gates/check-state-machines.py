#!/usr/bin/env python3
import os; sms=[f for f in os.listdir('state-machines') if f.endswith('.machine.json')]; print(f'PASS: {len(sms)} machines' if len(sms)>=7 else 'FAIL')
