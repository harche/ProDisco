#!/bin/bash
set -e
npx changeset publish
npm publish || true
