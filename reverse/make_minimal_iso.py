# -*- coding: utf-8 -*-
"""生成一个最小的合法 ISO9660 镜像（用于测试 BMC 的 Redfish VirtualMedia 挂载）。

结构：LBA0-15 系统区 → LBA16 PVD → LBA17 结束符 → LBA18 路径表 →
LBA19 根目录 → LBA20 文件数据。全程手写，避免依赖 mkisofs/genisoimage。
"""
import struct
import sys

SECTOR = 2048
VOL_ID = b'MEGARAC-NEXT'
APP_ID = b'BMC VIRTUAL MEDIA TEST'
FILE_NAME = b'README.TXT;1'
FILE_BODY = (b'This image was generated to test Redfish VirtualMedia on a MegaRAC BMC.\r\n'
             b'If the host can read this file, the redirection works.\r\n')

PVD_LBA = 16
TERM_LBA = 17
PATH_LBA = 18
ROOT_LBA = 19
FILE_LBA = 20
TOTAL_SECTORS = FILE_LBA + (len(FILE_BODY) + SECTOR - 1) // SECTOR


def both16(v):
    return struct.pack('<H', v) + struct.pack('>H', v)


def both32(v):
    return struct.pack('<I', v) + struct.pack('>I', v)


def dtime7():
    # 年(自1900) 月 日 时 分 秒 时区(15分钟为单位)
    return bytes([125, 1, 1, 0, 0, 0, 0])


def dtime17():
    return b'2026010100000000' + b'\x00'


def dir_record(extent, length, flags, name):
    """构造一条目录记录（含标识符末尾的填充）"""
    rec_len = 33 + len(name)
    if rec_len % 2:
        rec_len += 1
    rec = bytearray(rec_len)
    rec[0] = rec_len
    rec[1] = 0
    rec[2:10] = both32(extent)
    rec[10:18] = both32(length)
    rec[18:25] = dtime7()
    rec[25] = flags
    rec[26] = 0
    rec[27] = 0
    rec[28:32] = both16(1)
    rec[32] = len(name)
    rec[33:33 + len(name)] = name
    return bytes(rec)


def pad(b):
    out = bytearray(b)
    while len(out) % SECTOR:
        out.append(0)
    return bytes(out)


img = bytearray(SECTOR * TOTAL_SECTORS)

# ---- PVD ----
pvd = bytearray(SECTOR)
pvd[0] = 1
pvd[1:6] = b'CD001'
pvd[6] = 1
pvd[8:40] = b' '*32
pvd[40:72] = VOL_ID.ljust(32)
pvd[80:88] = both32(TOTAL_SECTORS)
pvd[120:124] = both16(1)          # 卷集大小
pvd[124:128] = both16(1)          # 卷序号
pvd[128:132] = both16(SECTOR)     # 逻辑块大小
pvd[132:140] = both32(10)         # 路径表大小
pvd[140:144] = struct.pack('<I', PATH_LBA)
pvd[148:152] = struct.pack('>I', PATH_LBA)
pvd[156:190] = dir_record(ROOT_LBA, SECTOR, 0x02, b'\x00')
pvd[190:318] = b' '*128
pvd[318:446] = b' '*128
pvd[446:574] = b' '*128
pvd[574:702] = APP_ID.ljust(128)
pvd[702:739] = b' '*37
pvd[739:776] = b' '*37
pvd[776:813] = b' '*37
pvd[813:830] = dtime17()
pvd[830:847] = dtime17()
pvd[847:864] = b'0'*16 + b'\x00'
pvd[864:881] = b'0'*16 + b'\x00'
pvd[881] = 1
img[PVD_LBA*SECTOR:(PVD_LBA+1)*SECTOR] = pvd

# ---- 卷描述符结束符 ----
term = bytearray(SECTOR)
term[0] = 255
term[1:6] = b'CD001'
term[6] = 1
img[TERM_LBA*SECTOR:(TERM_LBA+1)*SECTOR] = term

# ---- 路径表（只有根） ----
pt = bytearray(10)
pt[0] = 1                      # 根目录标识符长度
pt[1] = 0
pt[2:6] = struct.pack('<I', ROOT_LBA)
pt[6:8] = struct.pack('<H', 1)  # 父目录号
pt[8] = 0                      # 根标识符
img[PATH_LBA*SECTOR:PATH_LBA*SECTOR+10] = pt

# ---- 根目录 ----
root = bytearray()
root += dir_record(ROOT_LBA, SECTOR, 0x02, b'\x00')   # .
root += dir_record(ROOT_LBA, SECTOR, 0x02, b'\x01')   # ..
root += dir_record(FILE_LBA, len(FILE_BODY), 0x00, FILE_NAME)
img[ROOT_LBA*SECTOR:ROOT_LBA*SECTOR+len(root)] = root

# ---- 文件内容 ----
img[FILE_LBA*SECTOR:FILE_LBA*SECTOR+len(FILE_BODY)] = FILE_BODY

out = sys.argv[1] if len(sys.argv) > 1 else 'reverse/test.iso'
with open(out, 'wb') as f:
    f.write(img)
print(f'已生成 {out}（{len(img)} 字节 = {TOTAL_SECTORS} 扇区，含 1 个文件 {FILE_NAME.decode()}）')
