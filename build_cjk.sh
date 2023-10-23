#!/bin/sh

version="0.72.2"
docker build --pull --rm -f "Dockerfile.base" -t sldaniel/outline-base:latest "." && \
docker build --rm -f "Dockerfile" -t sldaniel/outline:$version -t sldaniel/outline:latest "." && \
docker push sldaniel/outline:$version && \
docker push sldaniel/outline:latest