export type CommandClass = 'safe' | 'ask' | 'danger' | 'blocked';

export interface Classification {
  level: CommandClass;
  reason?: string;
}

/** Commands that only read. Matched against the start of each pipeline segment. */
const SAFE: RegExp[] = [
  /^(ls|dir|pwd|cd|cat|type|head|tail|wc|echo|which|where|whoami|date|tree|stat|file|du|df|sort|uniq|cut|basename|dirname|true)\b/,
  /^(grep|rg|egrep|fgrep|findstr|jq|diff|cmp)\b/,
  /^find\b(?!.*\s-(delete|exec|execdir|ok|fprint|fls))/,
  /^git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame|describe|remote(\s+-v|\s+show)?|tag(\s+-l|\s+--list)?|stash\s+list|config\s+--get)\b(?!.*\s(-D|-d|--delete)\b)/,
  /^(node|npm|npx|pnpm|yarn|python3?|pip3?|java|dotnet|go|sf|sfdx|code)\s+(-v|--version|version)\s*$/,
  /^npm\s+(ls|list|view|outdated|config\s+get)\b/,
  /^(sf|sfdx)\s+org\s+(list|display)\b(?!.*--verbose)/,
  /^(sf|sfdx)\s+org\s+list\s+(metadata|metadata-types|limits|users)\b/,
  /^(sf|sfdx)\s+data\s+(query|search|get\s+record)\b(?!.*--bulk)/,
  /^(sf|sfdx)\s+sobject\s+(describe|list)\b/,
  /^(sf|sfdx)\s+(alias\s+list|config\s+(list|get)|plugins(\s+--core)?\s*$|whoami|doctor|commands|help|search)\b/,
  /^(sf|sfdx)\s+apex\s+(list\s+log|get\s+log|get\s+test)\b/,
  /^(sf|sfdx)\s+project\s+(list\s+ignored|deploy\s+(report|preview)|retrieve\s+preview)\b/,
  /^(sf|sfdx)\s+package\s+(list|installed\s+list|version\s+list)\b/,
  /^(sf|sfdx)\s+limits\s+api\s+display\b/,
  /^(sf|sfdx)\s+schema\s+(sobject\s+(describe|list))\b/,
];

/** Commands that change a Salesforce org. */
const ORG_WRITE: RegExp[] = [
  /\b(sf|sfdx)\s+project\s+(deploy\s+(start|quick|resume|validate|cancel)|delete\s+source)\b/,
  /\b(sf|sfdx)\s+(force:)?(source|mdapi)[: ](deploy|push|delete)\b/,
  /\b(sf|sfdx)\s+data\s+(create|update|delete|upsert|import|resume)\b/,
  /\b(sf|sfdx)\s+data\s+\w+\s+(bulk|tree)\b/,
  /\b(sf|sfdx)\s+data\s+(bulk|tree)\b/,
  /\b(sf|sfdx)\s+apex\s+(run|run\s+test)\b/,
  /\b(sf|sfdx)\s+org\s+(delete|create|assign|generate\s+password|resume)\b/,
  /\b(sf|sfdx)\s+package\s+(install|uninstall|create|delete|version\s+(create|promote|delete))\b/,
  /\b(sf|sfdx)\s+api\s+request\b/,
  /\b(sf|sfdx)\s+(flow|community|agent)\s+\w*\s*(run|create|publish|activate|deactivate)\b/,
];

const DANGER: Array<[RegExp, string]> = [
  [/\b(sf|sfdx)\s+org\s+display\b.*--verbose/, 'Prints the org access token and auth URL.'],
  [/\b(sf|sfdx)\s+org\s+(login|logout)\b/, 'Changes which orgs this machine is signed in to.'],
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, 'Deletes files recursively or without confirmation.'],
  [/\b(rmdir|rd)\s+\/s\b/i, 'Deletes a directory tree.'],
  [/\bdel\s+.*\/[sqf]\b/i, 'Deletes files without confirmation.'],
  [/\bRemove-Item\b.*-(Recurse|Force)/i, 'Deletes files recursively or by force.'],
  [/\bgit\s+push\b/, 'Publishes commits to a remote.'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|restore\s|branch\s+-D)\b/, 'Discards local work.'],
  [/\bgit\s+.*--force\b/, 'Forces a git operation.'],
  [/\bsudo\b|\brunas\b/i, 'Runs with elevated privileges.'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|zsh|iex|powershell|pwsh)\b/i, 'Downloads and executes a script.'],
  [/\b(shutdown|reboot|mkfs|diskpart|format)\b/i, 'Affects the whole machine.'],
  [/\bnpm\s+publish\b/, 'Publishes a package.'],
  [/\b(chmod|chown)\s+-R\b/, 'Changes permissions recursively.'],
  [/>\s*\/dev\/sd|\bdd\s+if=/, 'Writes directly to a disk.'],
];

/** Anything that would put a secret on screen and so into the model's context. */
const SECRET_ACCESS: RegExp[] = [
  /(^|[\s"'=/\\])\.env(\.(?!example|template)[\w.-]+)?(?=$|[\s"';|&)])/i,
  /\.forge-agent\b/i,
  /(^|[\s"'/\\])\.(sfdx|sf|ssh|aws|azure)[/\\]/i,
  /\b(id_rsa|id_ed25519)\b|\.(pem|pfx|p12)\b/i,
  /\bCLIENT_SECRET\b|\bAZURE_OPENAI_API_KEY\b/i,
];

/** Splits on shell operators outside quotes. Good enough to inspect each command in a chain. */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (command[i + 1] === c) i++;
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function classifyCommand(command: string, opts: { orgWrites: 'ask' | 'block' } = { orgWrites: 'ask' }): Classification {
  const cmd = command.trim();
  if (!cmd) return { level: 'blocked', reason: 'Empty command.' };

  if (SECRET_ACCESS.some((re) => re.test(cmd))) {
    return { level: 'blocked', reason: 'The command touches a secrets file or credential store. Run it yourself in a terminal if you need it.' };
  }
  if (ORG_WRITE.some((re) => re.test(cmd))) {
    if (opts.orgWrites === 'block') {
      return { level: 'blocked', reason: 'Commands that change a Salesforce org are disabled (forge.salesforce.orgWrites = block).' };
    }
    return { level: 'danger', reason: 'Changes a Salesforce org. Check the target org alias before approving.' };
  }
  for (const [re, reason] of DANGER) if (re.test(cmd)) return { level: 'danger', reason };

  // Substitution, redirection and background jobs can hide anything, so they never auto-run.
  // Quoted text is ignored here so a SOQL "WHERE Amount > 5" stays safe.
  const unquoted = cmd.replace(/"[^"]*"|'[^']*'/g, '""');
  if (/[`]|\$\(|>|<\(/.test(unquoted)) return { level: 'ask' };

  const segments = splitSegments(cmd);
  const allSafe = segments.length > 0 && segments.every((s) => SAFE.some((re) => re.test(s)));
  return { level: allSafe ? 'safe' : 'ask' };
}

/** Short prefix used for "always allow" in a session: the program plus its first subcommand words. */
export function commandPrefix(command: string): string {
  const first = splitSegments(command)[0] ?? command;
  const words = first.split(/\s+/).filter((w) => !w.startsWith('-'));
  const take = /^(sf|sfdx)$/.test(words[0] ?? '') ? 3 : /^(git|npm|npx|pnpm|yarn|dotnet|docker|kubectl|az)$/.test(words[0] ?? '') ? 2 : 1;
  return words.slice(0, take).join(' ');
}
