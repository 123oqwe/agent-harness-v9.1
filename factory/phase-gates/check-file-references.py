#!/usr/bin/env python3
import os,sys; print('PASS' if all(os.path.exists(f) for f in sys.argv[1:]) else 'FAIL')
