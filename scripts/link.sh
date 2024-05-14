test -f node_modules/.bin/oyster-api || ln -s ../../packages/api/build/index.js node_modules/.bin/oyster-api
chmod +x packages/api/build/index.js