# Release

1. Get branch approved and merged
1. Pull the updated master branch locally
1. Run `npm version` - bump the version appropriately (this will commit and tag master). ex: `npm version 1.0.8`
1. Push commit to github w/ tags `git push origin --tags`
1. Run `yarn build`
1. Run `npm publish` (your npm account will need to have publish access)
1. After publishing, there will be a release in github with this tagname. Edit the release notes with any changes and attach the `.tgz` file that was created by `yarn build`.

