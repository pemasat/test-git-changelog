import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import simpleGit from "simple-git";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const git = simpleGit();
const versionFile = path.resolve(__dirname, "version.txt");
const changelogFile = path.resolve(__dirname, "CHANGELOG.md");

interface Version {
  X: number; // fixed version, number 4 will be forever
  Y: number; // major version, changed only when we make a new generation
  Z: number; // release version, changed when we make a new UAT release
  R: number; // revision version, changed when we make a new UAT release
}

const readCurrentVersion = (): Version => {
  const [X, Y, Z, R] = fs
    .readFileSync(versionFile, "utf-8")
    .trim()
    .split(".")
    .map(Number);
  return { X, Y, Z, R };
};

const writeVersion = (v: Version) => {
  fs.writeFileSync(versionFile, `${v.X}.${v.Y}.${v.Z}.${v.R}`, "utf-8");
};

const getAllTags = async () => {
  const tags = await git.tags();
  return tags.all.filter((tag) => /^\d+\.\d+\.\d+\.\d+$/.test(tag));
};

const getChangelogSince = async (fromTag: string): Promise<string[]> => {
  const logs = await git.raw([
    "log",
    `${fromTag}..HEAD`,
    "--pretty=format:%s",
    "--no-merges",
  ]);
  return logs
    .split("\n")
    .filter((line) => /^[\u{1F4A5}\u{2728}\u{1F41B}]/u.test(line.trim()));
};

const updateChangelog = (version: string, logLines: string[]) => {
  const date = new Date().toISOString().split("T")[0];
  const entry = `## ${version} (${date})\n${logLines
    .map((l) => `- ${l}`)
    .join("\n")}\n\n`;
  const existing = fs.existsSync(changelogFile)
    ? fs.readFileSync(changelogFile, "utf-8")
    : "";
  fs.writeFileSync(changelogFile, entry + existing);
};

const deleteRemoteTag = async (tag: string) => {
  await git.push(["--delete", "origin", tag]).catch(() => {});
  await git.tag(["-d", tag]).catch(() => {});
};

(async () => {
  const current = readCurrentVersion();
  const currentTag = `${current.X}.${current.Y}.${current.Z}.${current.R}`;

  const newTagMakeUATRelease = `${current.X}.${current.Y}.${current.Z}.${
    current.R + 1
  }`;

  const { releaseType } = await inquirer.prompt([
    {
      type: "list",
      name: "releaseType",
      message: "Select release type:",
      choices: [
        `UAT release, current version: ${currentTag}, changes will be tagged as ${newTagMakeUATRelease}`,
        "UAT start work on next release",
        "PROD release",
        "GENERATION",
      ],
    },
  ]);

  if (releaseType === "UAT release") {
    current.R++;
    writeVersion(current);
    const logs = await getChangelogSince(currentTag);
    await git.addTag(newTagMakeUATRelease);
    await git.pushTags();
    updateChangelog(newTagMakeUATRelease, logs);
    console.log(`✅ UAT released: ${newTagMakeUATRelease}`);
  } else if (releaseType === "UAT start work on next release") {
    current.Z++;
    current.R = 0;
    writeVersion(current);
    console.log(
      `✅ Started work on UAT release: ${current.X}.${current.Y}.${current.Z}.${current.R}`
    );
  } else if (releaseType === "PROD release") {
    const tags = await getAllTags();
    const sorted = tags.sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true })
    );
    const { selectedTag } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedTag",
        message: "Select UAT tag to promote to PROD:",
        choices: sorted,
      },
    ]);

    await deleteRemoteTag("PRODUCTION-LATEST");
    await git.addTag("PRODUCTION-LATEST", selectedTag);
    await git.pushTags();

    const prodTag = `${selectedTag
      .split(".")
      .slice(0, 3)
      .join(".")}.PRODUCTION`;
    await deleteRemoteTag(prodTag);
    await git.addTag(prodTag, selectedTag);
    await git.pushTags();

    console.log(`✅ Promoted ${selectedTag} -> ${prodTag} & PRODUCTION-LATEST`);
  } else if (releaseType === "GENERATION") {
    current.Y++;
    current.Z = 0;
    current.R = 0;
    writeVersion(current);
    console.log(
      `✅ Generation version updated to: ${current.X}.${current.Y}.0.0`
    );
  }
})();
