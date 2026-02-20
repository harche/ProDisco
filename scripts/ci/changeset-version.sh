#!/bin/bash
set -e
npx changeset version
npm version patch --no-git-tag-version
