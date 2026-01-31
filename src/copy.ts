import * as p from '@clack/prompts';
import pc from 'picocolors';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { listInstalledSkills, type InstalledSkill } from './installer.ts';
import { runAdd } from './add.ts';
import { agents } from './agents.ts';
import { readSkillLock } from './skill-lock.ts';
import { searchSkillsAPI } from './find.ts';
import type { AgentType } from './types.ts';

export interface CopyOptions {
  source: string; // Source project directory path
  target: string; // Target project directory path
  skill?: string[]; // Filter specific skills (optional)
  force?: boolean; // Overwrite existing skills (default: false)
  yes?: boolean; // Skip confirmation prompts (default: false)
}

interface SkillToInstall {
  name: string;
  source: string; // owner/repo or URL
  agents: AgentType[]; // Keep original agent types from source
}

interface InstallResults {
  success: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

/**
 * Parse command line arguments for copy command
 */
export function parseCopyOptions(args: string[]): CopyOptions {
  const options: Partial<CopyOptions> = {
    skill: [],
    force: false,
    yes: false,
  };

  const positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--skill' || arg === '-s') {
      i++;
      while (i < args.length && args[i] && !args[i]!.startsWith('-')) {
        options.skill!.push(args[i]!);
        i++;
      }
      i--;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (!arg.startsWith('-')) {
      positionalArgs.push(arg);
    }
  }

  if (positionalArgs.length < 2) {
    throw new Error('Usage: skills copy SOURCE_DIR TARGET_DIR');
  }

  return {
    source: positionalArgs[0]!,
    target: positionalArgs[1]!,
    skill: options.skill,
    force: options.force,
    yes: options.yes,
  };
}

/**
 * Validate that source and target directories exist
 */
function validatePaths(source: string, target: string): void {
  const sourcePath = resolve(source);
  const targetPath = resolve(target);

  if (!existsSync(sourcePath)) {
    throw new Error(`Source directory does not exist: ${sourcePath}`);
  }

  if (!existsSync(targetPath)) {
    throw new Error(`Target directory does not exist: ${targetPath}`);
  }
}

/**
 * Get installed skills from source project
 */
async function getInstalledSkillsFromSource(sourceDir: string): Promise<InstalledSkill[]> {
  // Use listInstalledSkills from installer.ts
  const installedSkills = await listInstalledSkills({
    cwd: sourceDir,
    global: false, // Only project-level skills
  });

  if (installedSkills.length === 0) {
    throw new Error(`No skills found in source directory: ${sourceDir}`);
  }

  return installedSkills;
}

/**
 * Find skill source from global lock file or skills.sh registry
 */
async function findSkillSource(skillName: string): Promise<string | null> {
  // First, try to find in global lock file
  try {
    const lockFile = await readSkillLock();
    const lockEntry = lockFile.skills[skillName];

    if (lockEntry?.sourceUrl) {
      p.log.message(pc.dim(`  Found in lock file: ${lockEntry.source}`));
      return lockEntry.sourceUrl;
    }
  } catch {
    // Lock file not available, continue to search
  }

  // If not in lock file, search skills.sh
  try {
    p.log.message(pc.dim(`  Searching skills.sh for "${skillName}"...`));
    const results = await searchSkillsAPI(skillName);

    // Find exact match
    const exactMatch = results.find((r) => r.name.toLowerCase() === skillName.toLowerCase());

    if (exactMatch && exactMatch.source) {
      p.log.message(pc.dim(`  Found on skills.sh: ${exactMatch.source}`));
      return `${exactMatch.source}@${exactMatch.name}`;
    }

    // Try fuzzy match
    if (results.length > 0 && results[0]) {
      const fuzzyMatch = results[0];
      p.log.message(pc.yellow(`  Fuzzy match found: ${fuzzyMatch.source}@${fuzzyMatch.name}`));
      return `${fuzzyMatch.source}@${fuzzyMatch.name}`;
    }
  } catch {
    // Search failed, continue
  }

  return null;
}

/**
 * Resolve skills to installable sources
 */
async function resolveSkillSources(skills: InstalledSkill[]): Promise<SkillToInstall[]> {
  const resolved: SkillToInstall[] = [];

  for (const skill of skills) {
    p.log.step(pc.cyan(`Resolving ${skill.name}...`));

    const source = await findSkillSource(skill.name);

    if (source) {
      resolved.push({
        name: skill.name,
        source,
        agents: skill.agents, // Keep original AgentType[] from source
      });
      p.log.success(pc.green(`✓ ${skill.name} resolved`));
    } else {
      p.log.warn(pc.yellow(`⊘ ${skill.name} - Cannot find original source (skipping)`));
    }
  }

  return resolved;
}

/**
 * Filter skills by name patterns
 */
function filterSkills(
  installedSkills: InstalledSkill[],
  skillFilters?: string[]
): InstalledSkill[] {
  if (!skillFilters || skillFilters.length === 0) {
    return installedSkills;
  }

  const filtered: InstalledSkill[] = [];

  for (const skill of installedSkills) {
    const matches = skillFilters.some((filter) => {
      const normalizedFilter = filter.toLowerCase().replace(/\s+/g, '-');
      const normalizedSkill = skill.name.toLowerCase();

      return (
        normalizedSkill.includes(normalizedFilter) || normalizedFilter.includes(normalizedSkill)
      );
    });

    if (matches) {
      filtered.push(skill);
    }
  }

  return filtered;
}

/**
 * Show summary and get user confirmation
 */
async function confirmCopy(
  skills: SkillToInstall[],
  targetDir: string,
  skipConfirm: boolean
): Promise<boolean> {
  console.log();
  console.log(pc.bold('Copy Summary:'));
  console.log(`  Skills to install: ${skills.length}`);
  console.log(`  Target directory: ${targetDir}`);
  console.log();
  console.log(pc.bold('Skills:'));

  for (const skill of skills) {
    const agentNames = skill.agents.map((a) => agents[a]?.displayName || a).join(', ');
    console.log(`  - ${pc.cyan(skill.name)}`);
    console.log(`    ${pc.dim('Source:')} ${skill.source}`);
    console.log(`    ${pc.dim('Agents:')} ${agentNames}`);
  }
  console.log();

  if (skipConfirm) {
    return true;
  }

  const shouldContinue = await p.confirm({
    message: 'Continue with installation?',
  });

  return shouldContinue === true;
}

/**
 * Install skills in target project using runAdd from original sources
 */
async function installSkillsInTarget(
  skills: SkillToInstall[],
  targetDir: string,
  options: CopyOptions
): Promise<InstallResults> {
  const results: InstallResults = {
    success: [],
    skipped: [],
    failed: [],
  };

  // Save original directory
  const originalCwd = process.cwd();

  try {
    for (const skill of skills) {
      console.log(
        `${pc.dim('Installing')} ${pc.cyan(skill.name)} ${pc.dim('from')} ${skill.source}...`
      );

      try {
        // Change to target directory
        process.chdir(targetDir);

        // Extract skill name from source if it's in owner/repo@skill format
        const parts = skill.source.split('@');
        const repoSource = parts[0]!;
        const skillFilter = parts[1] || skill.name;

        // Install skill from original source using runAdd
        // Use the same agents as in source project
        await runAdd([repoSource], {
          agent: skill.agents,
          skill: [skillFilter],
          yes: true,
        });

        results.success.push(skill.name);
        console.log(`${pc.green('✓')} ${skill.name} installed`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        results.failed.push({ name: skill.name, error: errorMsg });
        console.error(`${pc.red('✗')} ${skill.name} failed: ${pc.dim(errorMsg)}`);
      } finally {
        // Always restore original directory
        process.chdir(originalCwd);
      }
    }
  } finally {
    // Ensure we restore directory even on unexpected errors
    process.chdir(originalCwd);
  }

  return results;
}

/**
 * Main entry point for copy command
 */
export async function runCopy(args: string[]): Promise<void> {
  try {
    // Parse options
    const options = parseCopyOptions(args);
    const { source, target, skill: skillFilter, yes } = options;

    // Resolve to absolute paths
    const sourceDir = resolve(source);
    const targetDir = resolve(target);

    console.log();
    p.intro(pc.bgCyan(pc.black(' skills copy ')));

    // Validate paths
    validatePaths(sourceDir, targetDir);

    const spinner = p.spinner();
    spinner.start('Discovering skills in source project...');

    // List installed skills in source project
    const installedSkills = await getInstalledSkillsFromSource(sourceDir);

    spinner.stop(
      `Found ${pc.green(installedSkills.length)} skill${installedSkills.length !== 1 ? 's' : ''}`
    );

    // Filter skills
    const skillsToResolve = filterSkills(installedSkills, skillFilter);

    if (skillsToResolve.length === 0) {
      p.log.warn('No skills found matching filter.');
      if (skillFilter && skillFilter.length > 0) {
        p.log.message(pc.dim(`  Filter: ${skillFilter.join(', ')}`));
        p.log.message(pc.dim('  Available skills:'));
        for (const skill of installedSkills) {
          p.log.message(pc.dim(`    - ${skill.name}`));
        }
      }
      p.outro(pc.yellow('No skills to install'));
      return;
    }

    if (skillFilter && skillFilter.length > 0) {
      p.log.info(
        `Selected ${skillsToResolve.length} skill${skillsToResolve.length !== 1 ? 's' : ''} matching filter`
      );
    }

    console.log();
    p.log.step(pc.bold('Resolving skill sources...'));
    console.log();

    // Resolve skill sources (from lock file or skills.sh)
    const skillsToInstall = await resolveSkillSources(skillsToResolve);

    if (skillsToInstall.length === 0) {
      console.log();
      p.log.error('No skills could be resolved to original sources');
      p.log.message(pc.dim('  Skills must be in the global lock file or available on skills.sh'));
      p.outro(pc.red('No skills to install'));
      process.exit(1);
    }

    console.log();

    // Show summary & confirm
    const shouldContinue = await confirmCopy(skillsToInstall, targetDir, yes || false);

    if (!shouldContinue) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }

    // Install skills
    spinner.start('Installing skills from original sources...');
    const results = await installSkillsInTarget(skillsToInstall, targetDir, options);
    spinner.stop('Installation complete');

    // Report results
    console.log();

    if (results.success.length > 0) {
      const successLines = results.success.map((name) => `${pc.green('✓')} ${name}`);
      p.note(
        successLines.join('\n'),
        pc.green(
          `Successfully installed ${results.success.length} skill${results.success.length !== 1 ? 's' : ''}`
        )
      );
    }

    if (results.skipped.length > 0) {
      console.log();
      p.log.warn(
        pc.yellow(
          `Skipped ${results.skipped.length} skill${results.skipped.length !== 1 ? 's' : ''}`
        )
      );
      for (const name of results.skipped) {
        p.log.message(`  ${pc.yellow('⊘')} ${name}`);
      }
    }

    if (results.failed.length > 0) {
      console.log();
      p.log.error(
        pc.red(
          `Failed to install ${results.failed.length} skill${results.failed.length !== 1 ? 's' : ''}`
        )
      );
      for (const failure of results.failed) {
        p.log.message(`  ${pc.red('✗')} ${failure.name}: ${pc.dim(failure.error)}`);
      }
    }

    console.log();

    if (results.success.length > 0 && results.failed.length === 0) {
      p.outro(pc.green('Done!'));
    } else if (results.success.length > 0) {
      p.outro(pc.yellow('Completed with some failures'));
    } else {
      p.outro(pc.red('All installations failed'));
      process.exit(1);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log();
    p.log.error(pc.red('Error:'));
    p.log.message(pc.dim(errorMsg));
    p.outro(pc.red('Copy failed'));
    process.exit(1);
  }
}
