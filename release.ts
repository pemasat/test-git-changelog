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

const loadRemoteTags = async () => {
  try {
    await git.fetch(["--tags"]);
  } catch (error) {
    console.error("Failed to fetch remote tags:", error);
    throw error;
  }
};

const findBiggerVersion = async () => {
  // compare current version in version.txt with all remote tags
  await loadRemoteTags();
  const currentVersion = readCurrentVersionFromFile();
  const allTags = await getAllTags();
  const biggerTags = allTags.filter((tag) => {
    const [X, Y, Z, R] = tag.split(".").map(Number);
    return (
      X > currentVersion.X ||
      (X === currentVersion.X && Y > currentVersion.Y) ||
      (X === currentVersion.X &&
        Y === currentVersion.Y &&
        Z > currentVersion.Z) ||
      (X === currentVersion.X &&
        Y === currentVersion.Y &&
        Z === currentVersion.Z &&
        R > currentVersion.R)
    );
  });
  return biggerTags.length > 0 ? biggerTags[0] : null;
};

const readCurrentVersionFromFile = (): Version => {
  const [X, Y, Z, R] = fs
    .readFileSync(versionFile, "utf-8")
    .trim()
    .split(".")
    .map(Number);
  return { X, Y, Z, R };
};

const writeVersionIntoFile = (v: Version) => {
  fs.writeFileSync(versionFile, `${v.X}.${v.Y}.${v.Z}.${v.R}`, "utf-8");
};

const getAllTags = async () => {
  const tags = await git.tags();
  return tags.all
    .filter((tag) => /^\d+\.\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
};

const getLatestTag = async (): Promise<string | null> => {
  const tags = await getAllTags();
  return tags.length > 0 ? tags[0] : null;
};

const tagExists = async (tag: string): Promise<boolean> => {
  const allTags = await git.tags();
  return allTags.all.includes(tag);
};

const getChangelogSince = async (fromTag: string): Promise<string[]> => {
  const exists = await tagExists(fromTag);
  const allTags = await getAllTags();
  console.log({ exists, fromTag, allTags });

  if (!exists) {
    console.warn(`Tag '${fromTag}' does not exist. Skipping changelog.`);
    return [];
  }

  const logs = await git.raw([
    "log",
    `${fromTag}..HEAD`,
    "--pretty=format:%s",
    "--no-merges",
  ]);
  console.log({ logs });

  return logs
    .split("\n")
    .filter((line) => /^[\u{1F4A5}\u{2728}\u{1F41B}]/u.test(line.trim()));
};

const updateChangelogAndCommitIt = (version: string, logLines: string[]) => {
  const date = new Date().toISOString().split("T")[0];
  const entry = `## ${version} (${date})\n${logLines
    .map((l) => `- ${l}`)
    .join("\n")}\n\n`;
  const existing = fs.existsSync(changelogFile)
    ? fs.readFileSync(changelogFile, "utf-8")
    : "";
  fs.writeFileSync(changelogFile, entry + existing);
  git.add([changelogFile, versionFile]);
  git.commit(`🧹 chore: update changelog for ${version}`);
};

const deleteRemoteTag = async (tag: string) => {
  await git.push(["--delete", "origin", tag]).catch(() => {});
  await git.tag(["-d", tag]).catch(() => {});
};

const getUnchangedFileCount = async () => {
  try {
    const status = await git.status();
    return (
      status.not_added.length + status.renamed.length + status.modified.length
    );
  } catch (error) {
    console.error("Failed to get unchanged file count:", error);
    return -1; // Indicate an error
  }
};

(async () => {
  const unchangedFileCount = await getUnchangedFileCount();
  if (unchangedFileCount > 0) {
    console.error(
      `There are ${unchangedFileCount} unchanged files. Please commit or stash them before proceeding.`
    );
    return;
  }

  const current = readCurrentVersionFromFile();

  const latestVersion = await findBiggerVersion();
  const latestTagVersion = getLatestTag();
  const currentVersionStr = `${current.X}.${current.Y}.${current.Z}.${current.R}`;
  const displayVersion = latestVersion || currentVersionStr;

  const newTagMakeUATRelease = `${current.X}.${current.Y}.${current.Z}.${
    current.R + 1
  }`;

  const choices = [
    `UAT release, current version: ${displayVersion}, changes will be tagged as ${newTagMakeUATRelease}`,
    "UAT start work on next release",
    "PROD release",
    "GENERATION",
  ];

  const { releaseType } = await inquirer.prompt([
    {
      type: "list",
      name: "releaseType",
      message: "Select release type:",
      choices,
    },
  ]);

  if (releaseType === choices[0]) {
    current.R++;
    writeVersionIntoFile(current);

    const fromTag =
      (await latestTagVersion) || latestVersion || currentVersionStr;
    const logs = await getChangelogSince(fromTag);
    console.log(`Preparing UAT release: ${newTagMakeUATRelease}`);
    if (logs.length === 0) {
      console.log("No changes to release, exiting.");
      return;
    }
    console.log(`Changes since last release:\n${logs.join("\n")}`);

    updateChangelogAndCommitIt(newTagMakeUATRelease, logs);

    await git.addTag(newTagMakeUATRelease);
    await deleteRemoteTag("UAT-LATEST");
    await git.addTag("UAT-LATEST");
    await git.pushTags();
    console.log(`✅ UAT released: ${newTagMakeUATRelease}`);
  } else if (releaseType === "UAT start work on next release") {
    current.Z++;
    current.R = 0;
    writeVersionIntoFile(current);
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
    writeVersionIntoFile(current);
    console.log(
      `✅ Generation version updated to: ${current.X}.${current.Y}.0.0`
    );
  }
})();
