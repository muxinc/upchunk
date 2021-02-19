# Release

1. Merge feature branches, bug fixes, and whatever changes into master after CI passes and PRs are approved
2. Create a new branch off master when you're ready to release a new version
3. Run `npm version` which will bump the version in `package.json` and make a tag (for example `npm version patch -m "Bump for 3.1.2"`). Follow SemVer rules for patch/minor/major.
4. Push the version commit and the tag `git push` && `git push --tags origin`
5. Open Pull Request, merge after approved. Make sure to "rebase and merge".
6. Create a new release in the Github UI, give the release a name and add release notes (creating the release will kick off npm publish)
