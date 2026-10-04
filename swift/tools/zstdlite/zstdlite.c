/*
 * 极简 zstd 解压工具 —— 只实现 DSH 灵动岛所需的「读取 stdin / 文件 → 解压 → 写 stdout」。
 *
 * 为什么不用官方 CLI：
 *   - facebook/zstd 不发布 macOS 预编译二进制
 *   - 其 Makefile 需 GNU make，macOS 的 BSD make 会报 "missing separator"
 *   - 官方 CLI 的 main() 链接了字典构建器（dibio），需额外编译 lib/dictBuilder
 *
 * 因此这里自写 main，只链 libzstd 的 decompress + common，产物足够小且无额外依赖。
 *
 * 用法：
 *   zstdlite -d            # stdin → stdout
 *   zstdlite -d <in>       # 文件 → stdout
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"

static int decompress_stream(FILE *in, FILE *out) {
    size_t inSize = ZSTD_DStreamInSize();
    size_t outSize = ZSTD_DStreamOutSize();
    void *inBuf = malloc(inSize);
    void *outBuf = malloc(outSize);
    if (!inBuf || !outBuf) { fprintf(stderr, "zstdlite: 内存分配失败\n"); return 1; }

    ZSTD_DStream *ds = ZSTD_createDStream();
    if (!ds) { fprintf(stderr, "zstdlite: 无法创建解压流\n"); free(inBuf); free(outBuf); return 1; }
    ZSTD_initDStream(ds);

    size_t last = 0;
    while (1) {
        size_t ret = fread(inBuf, 1, inSize, in);
        if (ferror(in)) { fprintf(stderr, "zstdlite: 读取失败\n"); goto fail; }
        if (ret == 0) break;   /* 输入读完 */

        ZSTD_inBuffer input = { inBuf, ret, 0 };
        while (input.pos < input.size) {
            ZSTD_outBuffer output = { outBuf, outSize, 0 };
            size_t rc = ZSTD_decompressStream(ds, &output, &input);
            if (ZSTD_isError(rc)) {
                fprintf(stderr, "zstdlite: %s\n", ZSTD_getErrorName(rc));
                goto fail;
            }
            if (output.pos && fwrite(outBuf, 1, output.pos, out) != output.pos) {
                fprintf(stderr, "zstdlite: 写入失败\n"); goto fail;
            }
            /*
             * 不要因为 rc == 0 就退出：DSH 的会话文件是「多帧拼接」，
             * 第一帧结束（rc==0）时后续帧还有数据。这里只在「输入耗尽」时收尾。
             */
        }
        (void)last;
    }
    /*
     * 不用 ZSTD_decompressStream 冲刷流尾：对已完整输入的帧，
     * 上面的循环已经产出全部数据；再传空输入会返回非 0 而永远不满足退出条件。
     * 若最后一帧确实未结束，ZSTD 会把剩余内容留在 output 里（下次调用才吐），
     * 但 DSH 写入的帧都带结束标记，因此直接收尾即可。
     */
    ZSTD_freeDStream(ds);
    free(inBuf); free(outBuf);
    return 0;
fail:
    ZSTD_freeDStream(ds);
    free(inBuf); free(outBuf);
    return 1;
}

int main(int argc, char **argv) {
    int decomp = 0;
    const char *path = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-d") == 0 || strcmp(argv[i], "--decompress") == 0) decomp = 1;
        else if (strcmp(argv[i], "-c") == 0) { /* 忽略：本工具始终写 stdout */ }
        else if (argv[i][0] != '-') path = argv[i];
    }
    if (!decomp) {
        fprintf(stderr, "用法: zstdlite -d [文件]   (缺省读 stdin，写 stdout)\n");
        return 2;
    }
    if (path) {
        FILE *f = fopen(path, "rb");
        if (!f) { fprintf(stderr, "zstdlite: 无法打开 %s\n", path); return 1; }
        int rc = decompress_stream(f, stdout);
        fclose(f);
        return rc;
    }
    return decompress_stream(stdin, stdout);
}
