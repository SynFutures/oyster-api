ARG API_NETWORK
ARG NODE_VERSION=20.12.2

FROM node:${NODE_VERSION}-alpine
WORKDIR /usr/src/app
COPY . .
RUN yarn
CMD yarn oyster-api start -n ${API_NETWORK}
EXPOSE 43210
