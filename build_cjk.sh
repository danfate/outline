#!/bin/sh
# version="0.70.2"
version=$RELEASE_VERSION
docker build --pull --rm -f "Dockerfile.base" -t sldaniel/outline-base:latest "." && \
docker build --rm -f "Dockerfile" -t sldaniel/outline:latest -t sldaniel/outline:$version "." && \
docker push sldaniel/outline:$version && \
docker push sldaniel/outline:latest
docker image rm sldaniel/outline:$version sldaniel/outline:latest sldaniel/outline-base:latest