#!/usr/bin/env bun
/** Open a reviewable stable-release update; never change the default branch or execute upstream code. */
const UPSTREAM = "can1357/oh-my-pi";
const BRANCH_PREFIX = "sync/upstream-";

type Api = (method: string, endpoint: string, body?: unknown) => Promise<any>;

export class GitHubApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export async function openUpstreamUpdate(repo: string, api: Api): Promise<string> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo === UPSTREAM) throw new Error("Expected a fork repository");
	const metadata = await api("GET", `/repos/${repo}`);
	if (!metadata.fork || metadata.parent?.full_name !== UPSTREAM)
		throw new Error("Repository is not the expected upstream fork");
	const base: string = metadata.default_branch;
	const baseSha: string = (await api("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`)).object.sha;
	const release = await api("GET", `/repos/${UPSTREAM}/releases/latest`);
	if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
		throw new Error("Latest upstream release is not a stable version tag");
	}
	const tag: string = release.tag_name;
	let object = (await api("GET", `/repos/${UPSTREAM}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
	for (let depth = 0; object.type === "tag" && depth < 8; depth++) {
		object = (await api("GET", `/repos/${UPSTREAM}/git/tags/${object.sha}`)).object;
	}
	if (object.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha))
		throw new Error("Release tag does not resolve to a commit");
	const sha: string = object.sha;
	const comparison = await api("GET", `/repos/${repo}/compare/${baseSha}...${sha}`);
	if (comparison.ahead_by === 0) return `Already includes upstream ${tag}; no PR needed.`;
	if (!Number.isInteger(comparison.ahead_by) || comparison.ahead_by < 0)
		throw new Error("Invalid upstream comparison");

	// Keep at most one outstanding update proposal; never overwrite edits made while reviewing it.
	for (let page = 1; ; page++) {
		const prs = await api(
			"GET",
			`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100&page=${page}`,
		);
		const pending = prs.find(
			(pr: any) => pr.head?.repo?.full_name === repo && pr.head?.ref?.startsWith(BRANCH_PREFIX),
		);
		if (pending) return `Review the existing upstream update first: ${pending.html_url}`;
		if (prs.length < 100) break;
	}

	const branch = `${BRANCH_PREFIX}${tag}`;
	// Matching refs avoids treating a missing branch as a failed API request.
	const refs = await api("GET", `/repos/${repo}/git/matching-refs/heads/${branch}`);
	const ref = refs.find((candidate: any) => candidate.ref === `refs/heads/${branch}`);
	if (ref && ref.object.sha !== sha) {
		const candidate = await api("GET", `/repos/${repo}/compare/${ref.object.sha}...${sha}`);
		if (candidate.ahead_by !== 0) throw new Error("Update branch has changed; refusing to overwrite it");
	}
	if (!ref) await api("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
	let conflicted = false;
	if (!ref || ref.object.sha === sha) {
		try {
			// Merge fork changes into the proposal, never into main. A conflict leaves the upstream ref intact.
			await api("POST", `/repos/${repo}/merges`, {
				base: branch,
				head: baseSha,
				commit_message: `Merge fork ${base} into upstream ${tag} update`,
			});
		} catch (error) {
			if (!(error instanceof GitHubApiError) || error.status !== 409) throw error;
			conflicted = true;
		}
	}

	const body = [
		`Proposes merging upstream stable release [${tag}](https://github.com/${UPSTREAM}/releases/tag/${tag}) into this fork.`,
		`Upstream commit: \`${sha}\`.`,
		"",
		conflicted
			? "The update conflicts with the fork. This draft branch retains the upstream commit; merge the current fork base into it and resolve conflicts before running validation."
			: "The proposal includes fork changes merged with the upstream release. Reviewer edits are preserved on subsequent runs.",
		"Use **Create a merge commit**, not squash/rebase, to preserve upstream ancestry and prevent repeated proposals.",
		"",
		"- Resolve conflicts without discarding fork-specific advisor fixes or workflows.",
		"- Review incoming source and workflow changes before approving any Actions runs.",
		"- Run the native-advisor regressions and the fork's manual Linux binary workflow on this update branch before merging. Native addons are built from source; no removed prebuilt-addon helper is needed.",
		"- Release tags and Nix activation remain manual. This automation does not merge the PR or publish a release.",
	].join("\n");
	const pr = await api("POST", `/repos/${repo}/pulls`, {
		title: `Update upstream to ${tag}`,
		head: branch,
		base,
		body,
		draft: conflicted,
		maintainer_can_modify: true,
	});
	return `Created upstream update: ${pr.html_url}`;
}

async function main(): Promise<void> {
	const repo = process.env.GITHUB_REPOSITORY;
	const token = process.env.GH_TOKEN;
	if (!repo || !token) throw new Error("GITHUB_REPOSITORY and runtime GH_TOKEN are required");
	const api: Api = async (method, endpoint, body) => {
		const response = await fetch(`https://api.github.com${endpoint}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok)
			throw new GitHubApiError(
				response.status,
				`GitHub API ${method} ${endpoint.split("?")[0]} failed: HTTP ${response.status}. Check workflow permissions; no existing branch was overwritten.`,
			);
		return response.status === 204 ? undefined : response.json();
	};
	const result = await openUpstreamUpdate(repo, api);
	console.log(result);
	if (process.env.GITHUB_STEP_SUMMARY) await Bun.write(process.env.GITHUB_STEP_SUMMARY, `${result}\n`);
}

if (import.meta.main) await main();
