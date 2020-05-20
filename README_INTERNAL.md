# Release

1. Get branch approved and merged
1. Pull the updated master branch locally
1. Run `npm version` - bump the version appropriately (this will commit and tag master)
1. Push commit to github
1. Run `yarn build`
1. Run `npm publish` (your npm account will need to have publish access)
1. After publishing, create a release in github and document the changes. Attach the build artifacts to the release.

