/**
 * CLI wrapper tools for Phase 2 Batch 4.
 * All use JSON stdin/stdout, never shell string concatenation.
 * AH-TOOL-SPREADSHEET-001, AH-TOOL-PRESENTATION-001, AH-TOOL-DOCUMENT-001, AH-TOOL-OCR-001
 */
import { spawn } from 'node:child_process';
import type { ToolResult } from './types.js';
import { ToolUnavailableError } from './types.js';

function runCli(command: string, args: string[], stdin: string, timeoutMs = 30000): Promise<ToolResult> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });
      let stdout = '';
      let stderr = '';
      proc.stdin?.write(stdin);
      proc.stdin?.end();
      proc.stdout?.on('data', d => stdout += d);
      proc.stderr?.on('data', d => stderr += d);
      proc.on('close', code => {
        if (code === 0) {
          try {
            resolve({ success: true, output: JSON.parse(stdout) });
          } catch {
            resolve({ success: true, output: stdout });
          }
        } else {
          resolve({ success: false, output: null, error: stderr || `exit code ${code}` });
        }
      });
      proc.on('error', err => {
        resolve({ success: false, output: null, error: err.message });
      });
    } catch (e) {
      resolve({ success: false, output: null, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

// AH-TOOL-SPREADSHEET-001
export async function manipulateSpreadsheet(input: {
  action: 'create' | 'read' | 'modify';
  file_path: string;
  data?: unknown;
}): Promise<ToolResult> {
  return runCli('python3', ['-c', `
import sys, json
try:
    from openpyxl import Workbook, load_workbook
except ImportError:
    print(json.dumps({"error": "openpyxl not installed"}))
    sys.exit(1)
data = json.loads(sys.stdin.read())
action = data.get("action")
path = data.get("file_path")
if action == "create":
    wb = Workbook()
    wb.save(path)
    print(json.dumps({"created": True, "path": path}))
elif action == "read":
    wb = load_workbook(path)
    sheets = {}
    for ws in wb.worksheets:
        sheets[ws.title] = [[cell.value for cell in row] for row in ws.iter_rows()]
    print(json.dumps({"sheets": sheets}))
else:
    print(json.dumps({"error": "unknown action"}))
`], JSON.stringify(input));
}

// AH-TOOL-PRESENTATION-001
export async function generatePresentation(input: {
  output_path: string;
  slides: Array<{ title: string; content?: string[] }>;
}): Promise<ToolResult> {
  return runCli('python3', ['-c', `
import sys, json
try:
    from pptx import Presentation
except ImportError:
    print(json.dumps({"error": "python-pptx not installed"}))
    sys.exit(1)
data = json.loads(sys.stdin.read())
prs = Presentation()
for slide_data in data.get("slides", []):
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = slide_data.get("title", "")
    if slide_data.get("content"):
        slide.placeholders[1].text = "\\n".join(slide_data["content"])
prs.save(data["output_path"])
print(json.dumps({"created": True, "path": data["output_path"], "slides": len(data["slides"])}))
`], JSON.stringify(input));
}

// AH-TOOL-DOCUMENT-001
export async function generateDocument(input: {
  output_path: string;
  title?: string;
  paragraphs?: string[];
  headings?: Array<{ text: string; level: number }>;
}): Promise<ToolResult> {
  return runCli('python3', ['-c', `
import sys, json
try:
    from docx import Document
except ImportError:
    print(json.dumps({"error": "python-docx not installed"}))
    sys.exit(1)
data = json.loads(sys.stdin.read())
doc = Document()
if data.get("title"):
    doc.add_heading(data["title"], 0)
for h in data.get("headings", []):
    doc.add_heading(h["text"], h["level"])
for p in data.get("paragraphs", []):
    doc.add_paragraph(p)
doc.save(data["output_path"])
print(json.dumps({"created": True, "path": data["output_path"]}))
`], JSON.stringify(input));
}

// AH-TOOL-OCR-001
export async function ocrDocument(input: {
  image_path: string;
  language?: string;
}): Promise<ToolResult> {
  return runCli('python3', ['-c', `
import sys, json
try:
    import pytesseract
    from PIL import Image
except ImportError:
    print(json.dumps({"error": "pytesseract/PIL not installed"}))
    sys.exit(1)
data = json.loads(sys.stdin.read())
img = Image.open(data["image_path"])
lang = data.get("language", "eng")
text = pytesseract.image_to_string(img, lang=lang)
print(json.dumps({"text": text, "language": lang}))
`], JSON.stringify(input));
}
