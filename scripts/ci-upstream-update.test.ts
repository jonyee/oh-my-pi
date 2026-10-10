import { describe, expect, it } from "bun:test";
import { GitHubApiError, openUpstreamUpdate } from "./ci-upstream-update";

const REPO = "owner/fork";
const BASE = "a".repeat(40);
const UPSTREAM = "b".repeat(40);
const MERGED = "c".repeat(40);

type Options = {
	included?: boolean;
	conflict?: boolean;
	pending?: boolean;
	ref?: string;
	tagType?: string;
	prerelease?: boolean;
	failure?: number;
};
function fixture(options: Options = {}) {
	const mutations: Array<{ endpoint: string; body: any }> = [];
	const api = async (method: string, endpoint: string, body?: any): Promise<any> => {
		if (method === "POST") {
			mutations.push({ endpoint, body });
			if (endpoint.endsWith("/merges")) {
				if (options.conflict || options.failure) throw new GitHubApiError(options.failure ?? 409, "merge rejected");
				return { sha: MERGED };
			}
			if (endpoint.endsWith("/pulls")) return { html_url: "https://github.com/owner/fork/pull/7" };
			return { ref: body.ref, object: { sha: body.sha } };
		}
		if (endpoint === `/repos/${REPO}`)
			return { fork: true, parent: { full_name: "can1357/oh-my-pi" }, default_branch: "main" };
		if (endpoint.endsWith("/git/ref/heads/main")) return { object: { sha: BASE } };
		if (endpoint.endsWith("/releases/latest"))
			return { tag_name: "v18.8.10", prerelease: !!options.prerelease, draft: false };
		if (endpoint.includes("/git/ref/tags/")) return { object: { type: options.tagType ?? "commit", sha: UPSTREAM } };
		if (endpoint.includes("/git/tags/")) return { object: { type: "commit", sha: UPSTREAM } };
		if (endpoint.includes(`/compare/${BASE}`)) return { ahead_by: options.included ? 0 : 3 };
		if (endpoint.includes("/compare/")) return { ahead_by: options.ref === MERGED ? 0 : 1 };
		if (endpoint.includes("/pulls?"))
			return options.pending
				? [
						{
							head: { repo: { full_name: REPO }, ref: "sync/upstream-v18.8.9" },
							html_url: "https://github.com/owner/fork/pull/6",
						},
					]
				: [];
		if (endpoint.includes("/git/matching-refs/"))
			return options.ref ? [{ ref: "refs/heads/sync/upstream-v18.8.10", object: { sha: options.ref } }] : [];
		throw new Error(`Unexpected request: ${method} ${endpoint}`);
	};
	return { api, mutations };
}

describe("upstream release proposals", () => {
	it("keeps fork history on the proposal branch without changing main", async () => {
		const { api, mutations } = fixture();
		expect(await openUpstreamUpdate(REPO, api)).toContain("/pull/7");
		expect(mutations.map(m => m.endpoint.split("/").at(-1))).toEqual(["refs", "merges", "pulls"]);
		expect(mutations[0].body).toEqual({ ref: "refs/heads/sync/upstream-v18.8.10", sha: UPSTREAM });
		expect(mutations[1].body).toMatchObject({ base: "sync/upstream-v18.8.10", head: BASE });
		expect(mutations[2].body).toMatchObject({ base: "main", head: "sync/upstream-v18.8.10", draft: false });
	});
	it("opens a draft on conflicts without resetting the fork or submitting conflict markers", async () => {
		const { api, mutations } = fixture({ conflict: true });
		await openUpstreamUpdate(REPO, api);
		expect(mutations.at(-1)?.body).toMatchObject({ draft: true, head: "sync/upstream-v18.8.10" });
		expect(mutations.filter(m => m.endpoint.endsWith("/git/refs"))).toHaveLength(1);
	});
	it.each([{ included: true }, { pending: true }])(
		"does not duplicate included or outstanding updates %j",
		async options => {
			const { api, mutations } = fixture(options);
			await openUpstreamUpdate(REPO, api);
			expect(mutations).toEqual([]);
		},
	);
	it("resolves annotated release tags", async () => {
		const { api, mutations } = fixture({ tagType: "tag" });
		await openUpstreamUpdate(REPO, api);
		expect(mutations[0].body.sha).toBe(UPSTREAM);
	});
	it("does not overwrite a resumed proposal with reviewer edits", async () => {
		const { api, mutations } = fixture({ ref: MERGED });
		await openUpstreamUpdate(REPO, api);
		expect(mutations).toHaveLength(1);
		expect(mutations[0].endpoint).toBe(`/repos/${REPO}/pulls`);
	});
	it("refuses an existing branch that no longer contains the target upstream commit", async () => {
		const { api, mutations } = fixture({ ref: BASE });
		await expect(openUpstreamUpdate(REPO, api)).rejects.toThrow("refusing to overwrite");
		expect(mutations).toEqual([]);
	});
	it("does not turn permission failures into conflict proposals", async () => {
		const { api, mutations } = fixture({ failure: 403 });
		await expect(openUpstreamUpdate(REPO, api)).rejects.toThrow("merge rejected");
		expect(mutations.some(m => m.endpoint.endsWith("/pulls"))).toBe(false);
	});
	it("rejects prereleases before publishing any branch", async () => {
		const { api, mutations } = fixture({ prerelease: true });
		await expect(openUpstreamUpdate(REPO, api)).rejects.toThrow("stable version");
		expect(mutations).toEqual([]);
	});
});
