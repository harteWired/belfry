/*
 * belfry-relay (C) — ultra-thin per-session stdio relay.
 *
 * Functionally identical to bin/belfry-relay.py, compiled to a ~1MB binary so
 * each session's MCP foothold costs ~1MB RSS instead of python's ~8MB. Claude
 * spawns one per session; it pipes the session's stdio JSON-RPC to the shared
 * belfry-broker over a unix socket. Channels are stdio-only, so each session
 * needs *a* stdio server — this is a transparent relay to the one broker.
 *
 * Resilience: a stable session_id (one per process) is sent in every handshake;
 * on a broker drop we reconnect and re-handshake with reconnect=true. The
 * broker re-registers under the same id and the daemon preserves messages
 * queued during the outage. We exit only when Claude closes our stdin.
 *
 * Build:  gcc -O2 -o bin/belfry-relay bin/belfry-relay.c
 *
 * Safety notes (reviewed): every string op is snprintf/bounds-checked; the
 * JSON builder escapes all interpolated values; reads/writes use sizeof bounds;
 * SIGPIPE is ignored so a write to a dropped socket returns EPIPE (handled)
 * rather than killing us; partial sends buffer the remainder for re-send after
 * reconnect; connect() is bounded by a deadline; the pump loop only continues
 * on real progress (EOF or drop always breaks).
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/select.h>

#define BUFSZ 65536
#define CONNECT_TIMEOUT_S 120

static char sockpath[300];
static char session_id[64];

/* JSON-escape src into dst (size dstsz). Always NUL-terminates; truncates if
 * the escaped form would overflow (leaves room for the longest escape +NUL). */
static void json_escape(char *dst, size_t dstsz, const char *src) {
    size_t j = 0;
    if (!src) src = "";
    for (size_t i = 0; src[i] && j + 7 < dstsz; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '"' || c == '\\') { dst[j++] = '\\'; dst[j++] = c; }
        else if (c == '\n') { dst[j++] = '\\'; dst[j++] = 'n'; }
        else if (c == '\r') { dst[j++] = '\\'; dst[j++] = 'r'; }
        else if (c == '\t') { dst[j++] = '\\'; dst[j++] = 't'; }
        else if (c < 0x20)  { j += (size_t)snprintf(dst + j, dstsz - j, "\\u%04x", c); }
        else dst[j++] = (char)c;
    }
    dst[j] = '\0';
}

static const char *env_or(const char *k, const char *def) {
    const char *v = getenv(k);
    return (v && *v) ? v : def;
}

static void slug_hint(char *out, size_t n) {
    const char *v = getenv("CLAUDE_SESSION_SLUG");
    if (!(v && *v)) v = getenv("CLAUDELIKE_BAR_NAME");
    char cwd[1024];
    if (!(v && *v)) {
        if (getcwd(cwd, sizeof cwd)) {
            char *base = strrchr(cwd, '/');
            v = (base && base[1]) ? base + 1 : cwd;
        } else {
            v = "unknown";
        }
    }
    /* Explicit precision bound keeps the slug hint within `out` (and silences
     * -Wformat-truncation). It's only a hint — the broker derives the real slug. */
    snprintf(out, n, "%.*s", (int)(n - 1), v);
}

static void make_session_id(void) {
    FILE *f = fopen("/proc/sys/kernel/random/uuid", "r");
    if (f && fgets(session_id, sizeof session_id, f)) {
        session_id[strcspn(session_id, "\n")] = '\0';
        fclose(f);
        return;
    }
    if (f) fclose(f);
    srand((unsigned)(time(NULL) ^ (long)getpid()));
    snprintf(session_id, sizeof session_id, "c-%08x%08x",
             (unsigned)rand(), (unsigned)rand());
}

static int build_handshake(char *buf, size_t n, int reconnect) {
    char cwd[1024];
    if (!getcwd(cwd, sizeof cwd)) snprintf(cwd, sizeof cwd, "/");
    char slug[256];
    slug_hint(slug, sizeof slug);

    char e_cwd[2048], e_slug[512], e_csl[512], e_cbn[512], e_bc[256];
    json_escape(e_cwd, sizeof e_cwd, cwd);
    json_escape(e_slug, sizeof e_slug, slug);
    const char *csl = getenv("CLAUDE_SESSION_SLUG");
    const char *cbn = getenv("CLAUDELIKE_BAR_NAME");
    json_escape(e_csl, sizeof e_csl, csl ? csl : "");
    json_escape(e_cbn, sizeof e_cbn, cbn ? cbn : "");
    json_escape(e_bc, sizeof e_bc, env_or("BELFRY_BROADCAST", ""));

    char envobj[1200];
    size_t eo = 0;
    int first = 1;
    eo += (size_t)snprintf(envobj + eo, sizeof envobj - eo, "{");
    if (csl && *csl) {
        eo += (size_t)snprintf(envobj + eo, sizeof envobj - eo,
                               "\"CLAUDE_SESSION_SLUG\":\"%s\"", e_csl);
        first = 0;
    }
    if (cbn && *cbn) {
        eo += (size_t)snprintf(envobj + eo, sizeof envobj - eo,
                               "%s\"CLAUDELIKE_BAR_NAME\":\"%s\"", first ? "" : ",", e_cbn);
    }
    snprintf(envobj + eo, sizeof envobj - eo, "}");

    return snprintf(buf, n,
        "{\"session_id\":\"%s\",\"slug_hint\":\"%s\",\"cwd\":\"%s\","
        "\"broadcast\":\"%s\",\"env\":%s,\"reconnect\":%s}\n",
        session_id, e_slug, e_cwd, e_bc, envobj, reconnect ? "true" : "false");
}

static int connect_broker(void) {
    time_t deadline = time(NULL) + CONNECT_TIMEOUT_S;
    struct sockaddr_un addr;
    if (strlen(sockpath) >= sizeof addr.sun_path) {
        fprintf(stderr, "belfry-relay: socket path too long\n");
        return -1;
    }
    while (time(NULL) < deadline) {
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) return -1;
        memset(&addr, 0, sizeof addr);
        addr.sun_family = AF_UNIX;
        snprintf(addr.sun_path, sizeof addr.sun_path, "%s", sockpath);
        if (connect(fd, (struct sockaddr *)&addr, sizeof addr) == 0) return fd;
        close(fd);
        struct timespec ts = {0, 500L * 1000 * 1000};
        nanosleep(&ts, NULL);
    }
    return -1;
}

/* Write all n bytes; returns bytes written (== n on success, < n on error). */
static size_t write_all(int fd, const char *buf, size_t n) {
    size_t off = 0;
    while (off < n) {
        ssize_t w = write(fd, buf + off, n - off);
        if (w < 0) { if (errno == EINTR) continue; return off; }
        if (w == 0) return off;
        off += (size_t)w;
    }
    return off;
}

int main(void) {
    signal(SIGPIPE, SIG_IGN);

    const char *bs = getenv("BELFRY_BROKER_SOCK");
    if (bs && *bs) {
        snprintf(sockpath, sizeof sockpath, "%s", bs);
    } else {
        const char *sd = getenv("BELFRY_STATE_DIR");
        if (sd && *sd) {
            snprintf(sockpath, sizeof sockpath, "%s/broker.sock", sd);
        } else {
            const char *xdg = getenv("XDG_STATE_HOME");
            const char *home = env_or("HOME", "/home/node");
            if (xdg && *xdg) snprintf(sockpath, sizeof sockpath, "%s/belfry/broker.sock", xdg);
            else snprintf(sockpath, sizeof sockpath, "%s/.local/state/belfry/broker.sock", home);
        }
    }
    make_session_id();

    char hs[6000];
    char buf[BUFSZ];
    char pending[BUFSZ];
    size_t pending_len = 0;
    int reconnect = 0;
    int stdin_eof = 0;

    while (!stdin_eof) {
        int sock = connect_broker();
        if (sock < 0) {
            fprintf(stderr, "belfry-relay: broker %s unavailable\n", sockpath);
            return 1;
        }
        int hlen = build_handshake(hs, sizeof hs, reconnect);
        if (hlen <= 0 || write_all(sock, hs, (size_t)hlen) < (size_t)hlen) { close(sock); continue; }
        if (pending_len) {
            if (write_all(sock, pending, pending_len) < pending_len) { close(sock); continue; }
            pending_len = 0;
        }
        reconnect = 1;

        int drop = 0;
        while (!drop && !stdin_eof) {
            fd_set rfds;
            FD_ZERO(&rfds);
            FD_SET(0, &rfds);
            FD_SET(sock, &rfds);
            int rv = select(sock + 1, &rfds, NULL, NULL, NULL);
            if (rv < 0) { if (errno == EINTR) continue; break; }

            if (FD_ISSET(0, &rfds)) {
                ssize_t n = read(0, buf, sizeof buf);
                if (n < 0) { if (errno == EINTR) continue; stdin_eof = 1; break; }
                if (n == 0) { stdin_eof = 1; break; }      /* Claude closed stdin */
                size_t w = write_all(sock, buf, (size_t)n);
                if (w < (size_t)n) {                        /* broker dropped mid-send */
                    size_t rem = (size_t)n - w;
                    if (rem > sizeof pending) rem = sizeof pending;
                    memcpy(pending, buf + w, rem);
                    pending_len = rem;
                    drop = 1;
                    break;
                }
            }
            if (FD_ISSET(sock, &rfds)) {
                ssize_t n = read(sock, buf, sizeof buf);
                if (n < 0) { if (errno == EINTR) continue; drop = 1; break; }
                if (n == 0) { drop = 1; break; }            /* broker dropped */
                if (write_all(1, buf, (size_t)n) < (size_t)n) { stdin_eof = 1; break; }
            }
        }
        close(sock);
    }
    return 0;
}
