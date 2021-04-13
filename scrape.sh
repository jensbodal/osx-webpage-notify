#!/bin/bash

export PATH="/Users/bodal/local/n/n/versions/node/14.6.0/bin:$PATH"

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

function run() {
  cd $DIR

  "$DIR/node_modules/.bin/ts-node" "$DIR/scrape.ts"
}

run
