import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

let _seq = 0;
function uniqueTempFile(prefix: string): string {
  return join(tmpdir(), `${prefix}_${Date.now()}_${_seq++}.js`);
}

// Helper function to execute OmniFocus scripts (single attempt)
async function executeJXAOnce(script: string): Promise<any[]> {
  // Write the script to a temporary file in the system temp directory
  const tempFile = uniqueTempFile('jxa_script');

  // Write the script to the temporary file
  writeFileSync(tempFile, script);

  let stdout: string;
  try {
    const result = await execAsync(`osascript -l JavaScript "${tempFile}"`, { timeout: 30000 });
    stdout = result.stdout;
    if (result.stderr) {
      console.error("Script stderr output:", result.stderr);
    }
  } finally {
    try { unlinkSync(tempFile); } catch { /* ignore */ }
  }

  // Parse the output as JSON
  try {
    const result = JSON.parse(stdout);
    return result;
  } catch (e) {
    console.error("Failed to parse script output as JSON:", e);

    // If this contains a "Found X tasks" message, treat it as a successful non-JSON response
    if (stdout.includes("Found") && stdout.includes("tasks")) {
      return [];
    }

    return [];
  }
}

// Execute JXA with a single retry on transient failures (e.g. embeddingd hiccups)
export async function executeJXA(script: string): Promise<any[]> {
  try {
    return await executeJXAOnce(script);
  } catch (error) {
    console.error('[jxa] First attempt failed, retrying in 200ms:', (error as Error).message);
    await new Promise(r => setTimeout(r, 200));
    return await executeJXAOnce(script);
  }
}

// Function to execute scripts in OmniFocus using the URL scheme
// Update src/utils/scriptExecution.ts
export async function executeOmniFocusScript(scriptPath: string, args?: any): Promise<any> {
  try {
    // Get the actual script path (existing code remains the same)
    let actualPath;
    if (scriptPath.startsWith('@')) {
      const scriptName = scriptPath.substring(1);
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      
      const distPath = join(__dirname, '..', 'utils', 'omnifocusScripts', scriptName);
      const srcPath = join(__dirname, '..', '..', 'src', 'utils', 'omnifocusScripts', scriptName);
      
      if (existsSync(distPath)) {
        actualPath = distPath;
      } else if (existsSync(srcPath)) {
        actualPath = srcPath;
      } else {
        actualPath = join(__dirname, '..', 'omnifocusScripts', scriptName);
      }
    } else {
      actualPath = scriptPath;
    }
    
    // Read the script file
    const scriptContent = readFileSync(actualPath, 'utf8');
    
    // Create a temporary file for our JXA wrapper script
    const tempFile = uniqueTempFile('jxa_wrapper');
    
    // Escape the script content properly for use in JXA
    const escapedScript = scriptContent.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    
    // Create a JXA script that will execute our OmniJS script in OmniFocus
    const jxaScript = `
    function run() {
      try {
        const app = Application('OmniFocus');
        app.includeStandardAdditions = true;
        
        // Run the OmniJS script in OmniFocus and capture the output
        const result = app.evaluateJavascript(\`${escapedScript}\`);
        
        // Return the result
        return result;
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }
    `;
    
    // Write the JXA script to the temporary file
    writeFileSync(tempFile, jxaScript);
    
    // Execute the JXA script using osascript
    const { stdout, stderr } = await execAsync(`osascript -l JavaScript "${tempFile}"`, { timeout: 30000 });

    // Clean up the temporary file
    unlinkSync(tempFile);
    
    if (stderr) {
      console.error("Script stderr output:", stderr);
    }
    
    // Parse the output as JSON
    try {
      return JSON.parse(stdout);
    } catch (parseError) {
      console.error("Error parsing script output:", parseError);
      return stdout;
    }
  } catch (error) {
    console.error("Failed to execute OmniFocus script:", error);
    throw error;
  }
}
    