FROM python:3.13-alpine
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
# VERSION names the commit when the code comes as a `git archive` copy; a plain clone leaves its
# placeholder, and /healthz then says "working copy". REQUIRE_COMMIT=1 stops such a build instead.
ARG REQUIRE_COMMIT=0
COPY VERSION ./VERSION
RUN if [ "$REQUIRE_COMMIT" = 1 ] && grep -q 'Format' VERSION; then echo "VERSION has no commit: copy the code with git archive" >&2; exit 1; fi
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY web ./web
# data/ belongs to the user the server runs as, so that a volume made for it can be written
RUN mkdir -p /app/data && chown 1000:1000 /app/data
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD python -c "import os, sys, urllib.request; sys.exit(urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('APP_PORT', '15002'), timeout=2).status != 200)"
CMD ["python", "-m", "app"]
