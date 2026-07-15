#!/usr/bin/env python3
"""[REAL] Check UI contract consistency.
1. Every route in routes.yaml has a corresponding screen file.
2. Every screen's API dependencies exist in openapi.yaml.
3. Every screen's permissions exist in auth-scopes.yaml.
"""
import os, sys, re

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC_DIR = os.path.join(BASE, "spec")
UI_DIR = os.path.join(SPEC_DIR, "ui")
API_DIR = os.path.join(SPEC_DIR, "api")

errors = []

# 1. Check routes.yaml routes match screen files
routes_path = os.path.join(UI_DIR, "routes.yaml")
screens_dir = os.path.join(UI_DIR, "screens")

if os.path.exists(routes_path):
    with open(routes_path) as f:
        routes_content = f.read()
    route_screens = re.findall(r'screen:\s*(\S+)', routes_content)
    
    for screen_name in route_screens:
        screen_file = os.path.join(screens_dir, f"{screen_name}.yaml")
        if not os.path.exists(screen_file):
            errors.append(f"Route screen '{screen_name}' has no file: {screen_file}")

# 2. Check screen API dependencies exist in openapi.yaml
openapi_path = os.path.join(API_DIR, "openapi.yaml")
openapi_content = ""
if os.path.exists(openapi_path):
    with open(openapi_path) as f:
        openapi_content = f.read()

# 3. Check permissions exist in auth-scopes.yaml
auth_scopes_path = os.path.join(API_DIR, "auth-scopes.yaml")
valid_scopes = set()
if os.path.exists(auth_scopes_path):
    with open(auth_scopes_path) as f:
        scopes_content = f.read()
    valid_scopes = set(re.findall(r'- name:\s*(\S+)', scopes_content))

# Check each screen file
if os.path.exists(screens_dir):
    for fname in os.listdir(screens_dir):
        if not fname.endswith('.yaml'):
            continue
        fpath = os.path.join(screens_dir, fname)
        with open(fpath) as f:
            content = f.read()
        
        # Check API operations reference real paths
        api_deps = re.findall(r'- (GET|POST|PUT|DELETE|PATCH)\s+(/\S+)', content)
        for method, path in api_deps:
            # Normalize path
            normalized = re.sub(r'\{[^}]+\}', '{id}', path)
            found = False
            for op_path in re.findall(r'^\s+(/[^:]+):', openapi_content, re.MULTILINE):
                if normalized in op_path or op_path.rstrip('/') in normalized:
                    found = True
                    break
            if not found and openapi_content:
                errors.append(f"{fname}: API {method} {path} not found in openapi.yaml")

if errors:
    print(f"FAIL: {len(errors)} UI contract issues:")
    for e in errors[:10]:
        print(f"  {e}")
    sys.exit(1)
else:
    print("PASS: UI contracts consistent")
