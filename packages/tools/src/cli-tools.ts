/**
 * CLI wrapper tools for Phase 2 Batch 4.
 * All use JSON stdin/stdout, never shell string concatenation.
 * AH-TOOL-SPREADSHEET-001, AH-TOOL-PRESENTATION-001, AH-TOOL-DOCUMENT-001, AH-TOOL-OCR-001
 */
import { spawn } from 'node:child_process';
import type { ToolResult } from './types.js';
import { isAbsolute } from 'node:path';

const ALLOWED_DIRS = ['workspace', 'output', 'tmp', 'artifacts'];

function validatePath(path: string, field: string): void {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error(`${field} is required`);
  }
  // Reject absolute paths and path traversal
  if (isAbsolute(path) || path.includes('..')) {
    throw new Error(`${field} must be a relative path without traversal`);
  }
  // Must be within an allowed directory
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!ALLOWED_DIRS.some(dir => normalized === dir || normalized.startsWith(dir + '/'))) {
    throw new Error(`${field} must be within an allowed directory (${ALLOWED_DIRS.join(', ')})`);
  }
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB cap per stream

function runCli(command: string, args: string[], stdin: string, timeoutMs = 30000): Promise<ToolResult> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputCapped = false;
      proc.stdin?.write(stdin);
      proc.stdin?.end();
      proc.stdout?.on('data', d => {
        if (stdoutBytes + d.length > MAX_OUTPUT_BYTES) {
          if (!outputCapped) {
            stderr += '\n[stdout truncated at ' + MAX_OUTPUT_BYTES + ' bytes]';
            outputCapped = true;
          }
          proc.kill('SIGKILL');
          return;
        }
        stdoutBytes += d.length;
        stdout += d;
      });
      proc.stderr?.on('data', d => {
        if (stderrBytes + d.length > MAX_OUTPUT_BYTES) {
          if (!outputCapped) {
            stderr += '\n[stderr truncated at ' + MAX_OUTPUT_BYTES + ' bytes]';
            outputCapped = true;
          }
          return;
        }
        stderrBytes += d.length;
        stderr += d;
      });
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
      proc.on('timeout', () => {
        proc.kill('SIGKILL');
        resolve({ success: false, output: null, error: 'process timed out' });
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
  validatePath(input.file_path, 'file_path');
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
  validatePath(input.output_path, 'output_path');
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
  validatePath(input.output_path, 'output_path');
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
  validatePath(input.image_path, 'image_path');
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
