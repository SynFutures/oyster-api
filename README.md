# oyster-api

A self-host service used to query the status of oyster amm at any block number.

## Prerequisites

-   docker
-   docker compose >= 1.28

## Install

1. clone repo

    ```sh
    git clone https://github.com/SynFutures/oyster-api.git && cd oyster-api
    ```

2. edit `.env` file, add node endpoint URL and set network

    ```sh
    cp .env.example .env
    vim .env
    ```

3. start services

    ```sh
    docker-compose up
    ```

## API

reference to [here](./docs/api.md)
