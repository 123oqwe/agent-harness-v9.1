#!/usr/bin/env python3
"""Generate dashboard from current-state.json.
Dashboard is GENERATED, not authoritative.
"""
import json, os, sys, datetime

def generate():
    """Generate dashboard HTML from current-state.json."""
    cs_path = os.path.join(os.path.dirname(__file__), "..", "..", "control", "current-state.json")
    with open(cs_path) as f:
        state = json.load(f)
    
    html = f"""<!DOCTYPE html>
<html><head><title>Factory Dashboard (Generated)</title></head><body>
<h1>Agent Harness Factory Dashboard</h1>
<p><em>Generated from control/current-state.json at {datetime.datetime.now().isoformat()}</em></p>
<table border="1">
<tr><th>Key</th><th>Value</th></tr>
<tr><td>Specification</td><td>{state.get('specification')}</td></tr>
<tr><td>Factory Status</td><td>{state.get('factory_status')}</td></tr>
<tr><td>Product Status</td><td>{state.get('product_status')}</td></tr>
<tr><td>Production Status</td><td>{state.get('production_status')}</td></tr>
<tr><td>Current Phase</td><td>{state.get('phase', state.get('phases', {}).get('0', {}).get('status'))}</td></tr>
</table>
<h2>Phases</h2>
<table border="1">
<tr><th>Phase</th><th>Name</th><th>Status</th><th>Blockers</th></tr>
"""
    for phase_id, phase_info in state.get("phases", {}).items():
        html += f"<tr><td>{phase_id}</td><td>{phase_info.get('name','')}</td><td>{phase_info.get('status','')}</td><td>{len(phase_info.get('blockers',[]))}</td></tr>"
    
    html += "</table></body></html>"
    
    output_path = os.path.join(os.path.dirname(__file__), "dashboard.html")
    with open(output_path, 'w') as f:
        f.write(html)
    
    return output_path

if __name__ == "__main__":
    path = generate()
    print(f"Dashboard generated: {path}")
