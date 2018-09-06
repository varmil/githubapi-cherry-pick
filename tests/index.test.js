// @flow strict

import {
  fetchReferenceSha,
  updateReference,
} from "shared-github-internals/lib/git";
import { createTestContext } from "shared-github-internals/lib/tests/context";
import {
  createCommitFromLinesAndMessage,
  createReferences,
  fetchReferenceCommits,
  fetchReferenceCommitsFromSha,
} from "shared-github-internals/lib/tests/git";

import cherryPick from "../src";

let octokit, owner, repo;

beforeAll(() => {
  ({ octokit, owner, repo } = createTestContext());
});

describe("nominal behavior", () => {
  const [initial, feature1st, feature2nd, master1st] = [
    "initial",
    "feature 1st",
    "feature 2nd",
    "master 1st",
  ];

  const [initialCommit, feature1stCommit, feature2ndCommit, master1stCommit] = [
    {
      lines: [initial, initial, initial],
      message: initial,
    },
    {
      lines: [initial, feature1st, initial],
      message: feature1st,
    },
    {
      lines: [initial, feature1st, feature2nd],
      message: feature2nd,
    },
    {
      lines: [master1st, initial, initial],
      message: master1st,
    },
  ];

  const state = {
    initialCommit,
    refsCommits: {
      feature: [feature1stCommit, feature2ndCommit],
      master: [master1stCommit],
    },
  };

  let deleteReferences, refsDetails, sha;

  beforeAll(async () => {
    ({ deleteReferences, refsDetails } = await createReferences({
      octokit,
      owner,
      repo,
      state,
    }));
    sha = await cherryPick({
      // Cherry-pick all feature commits except the initial one.
      commits: refsDetails.feature.shas.slice(1),
      head: refsDetails.master.ref,
      octokit,
      owner,
      repo,
    });
  }, 20000);

  afterAll(() => deleteReferences());

  test("returned sha is the actual master ref sha", async () => {
    const actualRefSha = await fetchReferenceSha({
      octokit,
      owner,
      ref: refsDetails.master.ref,
      repo,
    });
    expect(actualRefSha).toBe(sha);
  });

  test("commits on master are the expected ones", async () => {
    const actualCommits = await fetchReferenceCommitsFromSha({
      octokit,
      owner,
      repo,
      sha,
    });
    expect(actualCommits).toEqual([
      initialCommit,
      master1stCommit,
      {
        lines: [master1st, feature1st, initial],
        message: feature1st,
      },
      {
        lines: [master1st, feature1st, feature2nd],
        message: feature2nd,
      },
    ]);
  });
});

describe("atomicity", () => {
  describe("one of the commits cannot be cherry-picked", () => {
    const [initial, feature1st, feature2nd, master1st] = [
      "initial",
      "feature 1st",
      "feature 2nd",
      "master 1st",
    ];

    const [initialCommit, master1stCommit] = [
      {
        lines: [initial, initial],
        message: initial,
      },
      {
        lines: [master1st, initial],
        message: feature1st,
      },
    ];

    let deleteReferences, refsDetails;

    beforeAll(async () => {
      ({ deleteReferences, refsDetails } = await createReferences({
        octokit,
        owner,
        repo,
        state: {
          initialCommit,
          refsCommits: {
            feature: [
              {
                lines: [initial, feature1st],
                message: feature1st,
              },
              {
                lines: [feature2nd, feature1st],
                message: feature2nd,
              },
            ],
            master: [master1stCommit],
          },
        },
      }));
    }, 15000);

    afterAll(() => deleteReferences());

    test(
      "whole operation aborted",
      async () => {
        try {
          await cherryPick({
            // Cherry-pick all feature commits except the initial one.
            commits: refsDetails.feature.shas.slice(1),
            head: refsDetails.master.ref,
            octokit,
            owner,
            repo,
          });
          throw new Error("The cherry-pick should have failed");
        } catch (error) {
          expect(error.message).toMatch(/Merge conflict/u);
          const masterCommits = await fetchReferenceCommits({
            octokit,
            owner,
            ref: refsDetails.master.ref,
            repo,
          });
          expect(masterCommits).toEqual([initialCommit, master1stCommit]);
        }
      },
      15000
    );
  });

  describe("the head reference changed", () => {
    const [initial, feature1st, master1st, master2nd] = [
      "initial",
      "feature 1st",
      "master 1st",
      "master 2nd",
    ];

    const [initialCommit, master1stCommit, master2ndCommit] = [
      {
        lines: [initial, initial],
        message: initial,
      },
      {
        lines: [master1st, initial],
        message: master1st,
      },
      {
        lines: [master1st, master2nd],
        message: master2nd,
      },
    ];

    let deleteReferences, refsDetails;

    beforeAll(async () => {
      ({ deleteReferences, refsDetails } = await createReferences({
        octokit,
        owner,
        repo,
        state: {
          initialCommit,
          refsCommits: {
            feature: [
              {
                lines: [initial, feature1st],
                message: feature1st,
              },
            ],
            master: [master1stCommit],
          },
        },
      }));
    }, 15000);

    afterAll(() => deleteReferences());

    test(
      "whole operation aborted",
      async () => {
        try {
          await cherryPick({
            _intercept: async ({ headInitialSha }) => {
              const newCommit = await createCommitFromLinesAndMessage({
                commit: master2ndCommit,
                octokit,
                owner,
                parent: headInitialSha,
                repo,
              });
              await updateReference({
                force: false,
                octokit,
                owner,
                ref: refsDetails.master.ref,
                repo,
                sha: newCommit,
              });
            },
            // Cherry-pick all feature commits except the initial one.
            commits: refsDetails.feature.shas.slice(1),
            head: refsDetails.master.ref,
            octokit,
            owner,
            repo,
          });
          throw new Error("The cherry-pick should have failed");
        } catch (error) {
          expect(error.message).toMatch(/Update is not a fast forward/u);
          const masterCommits = await fetchReferenceCommits({
            octokit,
            owner,
            ref: refsDetails.master.ref,
            repo,
          });
          expect(masterCommits).toEqual([
            initialCommit,
            master1stCommit,
            master2ndCommit,
          ]);
        }
      },
      15000
    );
  });
});

describe("what doesn't work but should", () => {
  describe("cherry-picking commits editing the same line", () => {
    const [initial, feature1st, feature2nd, master1st] = [
      "initial",
      "feature 1st",
      "feature 2nd",
      "master 1st",
    ];

    const [
      initialCommit,
      feature1stCommit,
      feature2ndCommit,
      master1stCommit,
    ] = [
      {
        lines: [initial, initial],
        message: initial,
      },
      {
        lines: [initial, feature1st],
        message: feature1st,
      },
      {
        lines: [initial, feature2nd],
        message: feature2nd,
      },
      {
        lines: [master1st, initial],
        message: master1st,
      },
    ];

    const state = {
      initialCommit,
      refsCommits: {
        feature: [feature1stCommit, feature2ndCommit],
        master: [master1stCommit],
      },
    };

    let deleteReferences, refsDetails;

    beforeAll(async () => {
      ({ deleteReferences, refsDetails } = await createReferences({
        octokit,
        owner,
        repo,
        state,
      }));
    }, 20000);

    afterAll(() => deleteReferences());

    test(
      "cherry-picking faces a merge conflict",
      async () => {
        try {
          await cherryPick({
            // Cherry-pick all feature commits except the initial one.
            commits: refsDetails.feature.shas.slice(1),
            head: refsDetails.master.ref,
            octokit,
            owner,
            repo,
          });
          throw new Error("The cherry-pick should have failed");
        } catch (error) {
          // Using `git cherry-pick` through a CLI would have worked fine.
          expect(error.message).toMatch(/Merge conflict/u);
          const masterCommits = await fetchReferenceCommits({
            octokit,
            owner,
            ref: refsDetails.master.ref,
            repo,
          });
          expect(masterCommits).toEqual([initialCommit, master1stCommit]);
        }
      },
      15000
    );
  });

  describe("cherry-picking a commit but not all its parents up to the most recent common ancestor", () => {
    const [initial, feature1st, feature2nd, master1st] = [
      "initial",
      "feature 1st",
      "feature 2nd",
      "master 1st",
    ];

    const [
      initialCommit,
      feature1stCommit,
      feature2ndCommit,
      master1stCommit,
    ] = [
      {
        lines: [initial, initial, initial],
        message: initial,
      },
      {
        lines: [initial, feature1st, initial],
        message: feature1st,
      },
      {
        lines: [initial, feature1st, feature2nd],
        message: feature2nd,
      },
      {
        lines: [master1st, initial, initial],
        message: master1st,
      },
    ];

    const state = {
      initialCommit,
      refsCommits: {
        feature: [feature1stCommit, feature2ndCommit],
        master: [master1stCommit],
      },
    };

    let deleteReferences, refsDetails;

    beforeAll(async () => {
      ({ deleteReferences, refsDetails } = await createReferences({
        octokit,
        owner,
        repo,
        state,
      }));
    }, 20000);

    afterAll(() => deleteReferences());

    test(
      "cherry-picked commit actually contains the changes of its parent",
      async () => {
        await cherryPick({
          // Cherry-pick only the last feature commit.
          commits: refsDetails.feature.shas.slice(-1),
          head: refsDetails.master.ref,
          octokit,
          owner,
          repo,
        });
        const masterCommits = await fetchReferenceCommits({
          octokit,
          owner,
          ref: refsDetails.master.ref,
          repo,
        });
        expect(masterCommits).toEqual([
          initialCommit,
          master1stCommit,
          {
            // Using `git cherry-pick` through a CLI, the lines would have been: `[master1st, initial, feature2nd]`
            lines: [master1st, feature1st, feature2nd],
            message: feature2nd,
          },
        ]);
      },
      15000
    );
  });
});
