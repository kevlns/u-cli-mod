import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './errors.js';

const execFileAsync = promisify(execFile);

export interface AuthenticodeResult {
  status: string;
  statusMessage: string;
  subject: string;
  thumbprint: string;
  notBefore: string;
  notAfter: string;
  sha256: string;
}

const SCRIPT_HEAD = String.raw`$p = `;

const SCRIPT_TAIL = String.raw`
$s = Get-AuthenticodeSignature -LiteralPath $p
[pscustomobject]@{
  Status = $s.Status.ToString()
  StatusMessage = $s.StatusMessage
  Subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }
  Thumbprint = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { $null }
  NotBefore = if ($s.SignerCertificate) { $s.SignerCertificate.NotBefore.ToString('o') } else { $null }
  NotAfter = if ($s.SignerCertificate) { $s.SignerCertificate.NotAfter.ToString('o') } else { $null }
  Sha256 = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
} | ConvertTo-Json -Compress
`;

/** PowerShell -EncodedCommand payload: script with the target path embedded. */
function encodedCommand(file: string): { script: string; encoded: string } {
  // Path is embedded directly (single-quoted, ''-escaped) instead of a param
  // block: `param()` in a -Command/-EncodedCommand script only binds from the
  // process command line, not from text appended inside the script.
  const script = `${SCRIPT_HEAD}'${file.replace(/'/g, "''")}'${SCRIPT_TAIL}`.replace(/\r?\n/g, '\r\n');
  // UTF-16LE base64 is what PowerShell's -EncodedCommand expects.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return { script, encoded };
}

/** Verify Authenticode: status Valid + signer subject contains expected + thumbprint matches. */
export async function verifyAuthenticode(
  file: string,
  expectedSubjectContains: string,
  expectedThumbprint: string,
  { powershell = 'powershell.exe' }: { powershell?: string } = {},
): Promise<AuthenticodeResult> {
  let stdout: string;
  try {
    const { encoded } = encodedCommand(file);
    const result = await execFileAsync(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], { maxBuffer: 4 * 1024 * 1024, timeout: 120_000, windowsHide: true });
    stdout = result.stdout;
  } catch (err) {
    throw new CliError(
      `无法执行 Authenticode 校验（需要 Windows PowerShell）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let result: AuthenticodeResult;
  try {
    const parsed = JSON.parse(stdout.trim());
    result = {
      status: String(parsed.Status ?? ''),
      statusMessage: String(parsed.StatusMessage ?? ''),
      subject: String(parsed.Subject ?? ''),
      thumbprint: String(parsed.Thumbprint ?? ''),
      notBefore: String(parsed.NotBefore ?? ''),
      notAfter: String(parsed.NotAfter ?? ''),
      sha256: String(parsed.Sha256 ?? ''),
    };
  } catch {
    throw new CliError(`Authenticode 校验输出无法解析：${stdout.slice(0, 300)}`);
  }
  if (result.status !== 'Valid') {
    throw new CliError(`CLI Authenticode 无效：${result.status} ${result.statusMessage}`);
  }
  if (!result.subject.includes(expectedSubjectContains)) {
    throw new CliError(
      `CLI 签名主体不匹配。期望包含 "${expectedSubjectContains}"，实际 "${result.subject}"`,
    );
  }
  if (result.thumbprint.toLowerCase() !== expectedThumbprint.toLowerCase()) {
    throw new CliError(
      `CLI 签名证书指纹不匹配。期望 ${expectedThumbprint}，实际 ${result.thumbprint}`,
    );
  }
  return result;
}