#!/bin/bash

cd /root/protra-3
yarn tsx ./general.ts >> ./logs/"$(date +%Y-%m).log" 2>&1
