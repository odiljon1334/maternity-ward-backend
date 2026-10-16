import { Injectable, NotFoundException } from '@nestjs/common';
import {
  EmployeeStatus,
  MonthlySchedulePlanStatus,
  SchedulePlanningMode,
  ShiftSwapStatus,
} from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '../prisma/prisma.service';
import { SchedulePlanningService } from '../schedule-planning/schedule-planning.service';
import { DateUtil, TZ } from '../common/utils/date.util';

type RiskLevel = 'CRITICAL' | 'WARNING' | 'SAFE';
type OperationalMode = 'STANDARD' | 'POST_COVERAGE' | 'FLEXIBLE';

type Candidate = {
  employeeId: string;
  fullName: string;
  departmentName: string | null;
  positionName: string | null;
  reason: string;
};

type OperationalRisk = {
  id: string;
  level: RiskLevel;
  kind: string;
  unitName: string;
  departmentName: string | null;
  title: string;
  description: string;
  employeeId?: string;
  employeeName?: string;
  startsAt?: Date | null;
  evidence: Array<{ label: string; value: string }>;
  candidates?: Candidate[];
  action: { label: string; href: string };
};

type ModeResult = {
  enabled: boolean;
  disabledReason?: string;
  metrics: {
    critical: number;
    warning: number;
    safe: number;
    monitored: number;
  };
  items: OperationalRisk[];
};

@Injectable()
export class OperationalCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedulePlanning: SchedulePlanningService,
  ) {}

  async getOverview(hospitalId: string) {
    const hospital = await this.prisma.hospital.findFirst({
      where: { id: hospitalId, isBlocked: false },
      select: { id: true, name: true, schedulePlanningMode: true },
    });
    if (!hospital) throw new NotFoundException('Muassasa topilmadi');

    const now = DateUtil.now();
    const [standard, postCoverage, flexible] = await Promise.all([
      this.getStandardMode(hospital.id, now),
      hospital.schedulePlanningMode === SchedulePlanningMode.POST_COVERAGE
        ? this.getPostCoverageMode(hospital.id, now)
        : Promise.resolve(this.disabledPostMode()),
      this.getFlexibleMode(hospital.id, now),
    ]);

    return {
      hospital,
      generatedAt: now.toISOString(),
      range: {
        start: now.startOf('day').format('YYYY-MM-DD'),
        end: now.add(6, 'day').endOf('day').format('YYYY-MM-DD'),
      },
      modes: {
        STANDARD: standard,
        POST_COVERAGE: postCoverage,
        FLEXIBLE: flexible,
      },
    };
  }

  private async getStandardMode(
    hospitalId: string,
    now: dayjs.Dayjs,
  ): Promise<ModeResult> {
    const today = DateUtil.startOfDay(now.toDate());
    const yesterday = DateUtil.startOfDay(now.subtract(1, 'day').toDate());
    const weekEnd = DateUtil.endOfDay(now.add(6, 'day').toDate());

    const [schedules, pendingSwaps] = await Promise.all([
      this.prisma.schedule.findMany({
        where: {
          date: today,
          status: 'WORKING',
          employee: {
            hospitalId,
            firedAt: null,
            status: EmployeeStatus.ACTIVE,
          },
        },
        include: {
          shift: true,
          attendance: true,
          employee: { include: { department: true, position: true } },
        },
        orderBy: { employee: { fullName: 'asc' } },
      }),
      this.prisma.shiftSwapRequest.findMany({
        where: {
          hospitalId,
          status: { in: [ShiftSwapStatus.REQUESTED, ShiftSwapStatus.ACCEPTED] },
          requesterDate: { gte: today, lte: weekEnd },
        },
        include: {
          requester: { include: { department: true, position: true } },
          target: { include: { department: true, position: true } },
        },
        orderBy: { requesterDate: 'asc' },
        take: 10,
      }),
    ]);

    const missing = schedules.filter((schedule) => {
      if (!schedule.shift || schedule.attendance?.checkIn) return false;
      const expected = DateUtil.buildDateTime(today, schedule.shift.startTime);
      return (
        now.toDate().getTime() >
        expected.getTime() + schedule.shift.graceMinutes * 60_000
      );
    });

    const candidates = await this.findCandidates(
      hospitalId,
      missing.map((schedule) => ({
        employeeId: schedule.employeeId,
        departmentId: schedule.employee.departmentId,
        positionId: schedule.employee.positionId,
      })),
      yesterday,
      today,
    );

    const items: OperationalRisk[] = missing.map((schedule) => {
      const shift = schedule.shift!;
      const expected = DateUtil.buildDateTime(today, shift.startTime);
      const delay = Math.max(0, now.diff(dayjs(expected), 'minute'));
      const level: RiskLevel = delay >= 30 ? 'CRITICAL' : 'WARNING';
      return {
        id: `missing-checkin-${schedule.id}`,
        level,
        kind: 'MISSING_CHECKIN',
        unitName: schedule.employee.department?.name ?? 'Bo‘limsiz',
        departmentName: schedule.employee.department?.name ?? null,
        title: `${schedule.employee.fullName} hali check-in qilmagan`,
        description: `${shift.startTime} smena boshlanishidan ${delay} daqiqa o‘tdi. Terminal yoki mobil check-in topilmadi.`,
        employeeId: schedule.employeeId,
        employeeName: schedule.employee.fullName,
        startsAt: expected,
        evidence: [
          { label: 'Smena', value: `${shift.startTime}–${shift.endTime}` },
          { label: 'Kechikish', value: `${delay} daqiqa` },
          { label: 'Manba', value: 'Grafik + davomat' },
        ],
        candidates: candidates.get(schedule.employeeId) ?? [],
        action: { label: 'Grafikni ochish', href: '/dashboard/schedules' },
      };
    });

    for (const swap of pendingSwaps) {
      items.push({
        id: `pending-swap-${swap.id}`,
        level: swap.status === ShiftSwapStatus.ACCEPTED ? 'WARNING' : 'WARNING',
        kind: 'PENDING_SHIFT_SWAP',
        unitName: swap.requester.department?.name ?? 'Bo‘limsiz',
        departmentName: swap.requester.department?.name ?? null,
        title:
          swap.status === ShiftSwapStatus.ACCEPTED
            ? 'Smena almashinuvi rahbar tasdig‘ini kutmoqda'
            : 'Smena almashinuvi hamkasb javobini kutmoqda',
        description: `${swap.requester.fullName} → ${swap.target.fullName}, ${dayjs(swap.requesterDate).tz(TZ).format('DD.MM.YYYY')}.`,
        employeeId: swap.requesterId,
        employeeName: swap.requester.fullName,
        startsAt: swap.requesterDate,
        evidence: [
          {
            label: 'Holat',
            value:
              swap.status === ShiftSwapStatus.ACCEPTED
                ? 'Rahbar tasdig‘i'
                : 'Hamkasb javobi',
          },
          {
            label: 'Turi',
            value: swap.type === 'SWAP' ? 'Smena almashish' : 'O‘rnini bosish',
          },
          { label: 'Manba', value: 'Smena almashish so‘rovi' },
        ],
        action: { label: 'So‘rovni ko‘rish', href: '/dashboard/shift-swaps' },
      });
    }

    const riskyDepartments = new Set(
      items.map((item) => item.departmentName).filter(Boolean),
    );
    const monitoredDepartments = new Set(
      schedules
        .map((schedule) => schedule.employee.department?.name)
        .filter(Boolean),
    );
    return this.modeResult(
      items,
      Math.max(0, monitoredDepartments.size - riskyDepartments.size),
      schedules.length,
    );
  }

  private async findCandidates(
    hospitalId: string,
    needs: Array<{
      employeeId: string;
      departmentId: string;
      positionId: string;
    }>,
    yesterday: Date,
    today: Date,
  ) {
    const result = new Map<string, Candidate[]>();
    if (!needs.length) return result;
    const departmentIds = [...new Set(needs.map((need) => need.departmentId))];
    const employees = await this.prisma.employee.findMany({
      where: {
        hospitalId,
        departmentId: { in: departmentIds },
        firedAt: null,
        status: EmployeeStatus.ACTIVE,
      },
      include: {
        department: true,
        position: true,
        schedules: {
          where: { date: { gte: yesterday, lte: today }, status: 'WORKING' },
          include: { shift: true },
        },
        leaveRequests: {
          where: {
            status: 'APPROVED',
            startDate: { lte: today },
            endDate: { gte: today },
          },
          select: { id: true },
        },
      },
    });

    for (const need of needs) {
      const available = employees
        .filter((employee) => {
          if (
            employee.id === need.employeeId ||
            employee.departmentId !== need.departmentId
          )
            return false;
          if (employee.leaveRequests.length) return false;
          return !employee.schedules.some((schedule) => {
            const sameDay = schedule.date.getTime() === today.getTime();
            const previousOvernight =
              schedule.date.getTime() === yesterday.getTime() &&
              schedule.shift?.isOvernight;
            return sameDay || previousOvernight;
          });
        })
        .sort(
          (a, b) =>
            Number(b.positionId === need.positionId) -
            Number(a.positionId === need.positionId),
        )
        .slice(0, 3)
        .map((employee) => ({
          employeeId: employee.id,
          fullName: employee.fullName,
          departmentName: employee.department?.name ?? null,
          positionName: employee.position?.name ?? null,
          reason:
            employee.positionId === need.positionId
              ? 'Lavozimi mos · bugun grafik biriktirilmagan'
              : 'Shu bo‘limda · bugun grafik biriktirilmagan',
        }));
      result.set(need.employeeId, available);
    }
    return result;
  }

  private async getPostCoverageMode(
    hospitalId: string,
    now: dayjs.Dayjs,
  ): Promise<ModeResult> {
    const [posts, plans] = await Promise.all([
      this.prisma.schedulePost.findMany({
        where: { hospitalId, isActive: true },
        include: { department: true },
        orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
      }),
      this.prisma.monthlySchedulePlan.findMany({
        where: {
          hospitalId,
          year: now.year(),
          month: now.month() + 1,
          status: {
            notIn: [
              MonthlySchedulePlanStatus.REJECTED,
              MonthlySchedulePlanStatus.ARCHIVED,
            ],
          },
        },
        orderBy: [{ postId: 'asc' }, { version: 'desc' }],
      }),
    ]);

    const latestByPost = new Map<string, (typeof plans)[number]>();
    for (const plan of plans) {
      if (!latestByPost.has(plan.postId)) latestByPost.set(plan.postId, plan);
    }

    const details = new Map<string, any>();
    await Promise.all(
      [...latestByPost.values()].map(async (plan) => {
        try {
          details.set(
            plan.id,
            await this.schedulePlanning.getPlanDetails(hospitalId, plan.id),
          );
        } catch {
          // Bitta buzilgan/eskirgan reja butun Operativ markazni yiqitmasin.
          details.set(plan.id, null);
        }
      }),
    );

    const items: OperationalRisk[] = [];
    let safe = 0;
    for (const post of posts) {
      const plan = latestByPost.get(post.id);
      if (!plan) {
        items.push({
          id: `missing-post-plan-${post.id}`,
          level: 'CRITICAL',
          kind: 'MISSING_POST_PLAN',
          unitName: post.name,
          departmentName: post.department.name,
          title: 'Joriy oy uchun post reja yaratilmagan',
          description: `${post.department.name} bo‘limidagi ushbu post uchun ${now.format('MMMM YYYY')} grafigi yo‘q.`,
          evidence: [
            { label: 'Post', value: post.name },
            { label: 'Oy', value: now.format('MM.YYYY') },
            { label: 'Manba', value: 'Post reja' },
          ],
          action: {
            label: 'Post reja yaratish',
            href: this.postPlanHref(post, now),
          },
        });
        continue;
      }

      const detail = details.get(plan.id);
      if (!detail) {
        items.push({
          id: `post-plan-read-error-${plan.id}`,
          level: 'WARNING',
          kind: 'POST_PLAN_READ_ERROR',
          unitName: post.name,
          departmentName: post.department.name,
          title: 'Post reja ma’lumotini qayta tekshirish kerak',
          description:
            'Reja mavjud, lekin qamrov xulosasini hisoblab bo‘lmadi. Post reja sahifasini ochib tekshiring.',
          evidence: [
            { label: 'Versiya', value: String(plan.version) },
            { label: 'Holat', value: plan.status },
            { label: 'Manba', value: 'Post reja' },
          ],
          action: {
            label: 'Post rejani ochish',
            href: this.postPlanHref(post, now, plan.id),
          },
        });
        continue;
      }
      const summary = detail?.summary;
      const remaining = Number(summary?.remainingMinutes ?? 0);
      const excess = Number(summary?.excessMinutes ?? 0);
      const pendingChanges = (detail?.changeRequests ?? []).filter(
        (change: any) => ['REQUESTED', 'ACCEPTED'].includes(change.status),
      ).length;

      if (plan.status !== MonthlySchedulePlanStatus.APPROVED) {
        items.push({
          id: `unfinished-post-plan-${plan.id}`,
          level:
            plan.status === MonthlySchedulePlanStatus.DRAFT
              ? 'CRITICAL'
              : 'WARNING',
          kind: 'UNFINISHED_POST_PLAN',
          unitName: post.name,
          departmentName: post.department.name,
          title:
            plan.status === MonthlySchedulePlanStatus.DRAFT
              ? 'Post reja hali qoralama holatida'
              : 'Post reja rahbar tasdig‘ini kutmoqda',
          description:
            plan.status === MonthlySchedulePlanStatus.DRAFT
              ? `Versiya ${plan.version}. Kadr inspektori rejani tayyorlab, rahbar tasdig‘iga yuborishi kerak.`
              : `Versiya ${plan.version}. Reja rahbarning tasdiqlash yoki rad etish qarorini kutmoqda.`,
          evidence: [
            { label: 'Holat', value: plan.status },
            { label: 'Qolgan', value: this.hours(remaining) },
            { label: 'Oshgan', value: this.hours(excess) },
            {
              label: 'Keyingi amal',
              value:
                plan.status === MonthlySchedulePlanStatus.DRAFT
                  ? 'Kadr inspektori yuboradi'
                  : 'Rahbar qaror beradi',
            },
          ],
          action: {
            label:
              plan.status === MonthlySchedulePlanStatus.DRAFT
                ? 'Qoralamani ochish'
                : 'Tasdiqlash uchun ochish',
            href: this.postPlanHref(post, now, plan.id),
          },
        });
      } else if (remaining || excess) {
        items.push({
          id: `post-plan-balance-${plan.id}`,
          level: 'WARNING',
          kind: 'POST_PLAN_BALANCE',
          unitName: post.name,
          departmentName: post.department.name,
          title: 'Tasdiqlangan post normasi qayta tekshirilishi kerak',
          description: remaining
            ? `Post normasiga ${this.hours(remaining)} yetishmaydi.`
            : `Post normasidan ${this.hours(excess)} oshib ketgan.`,
          evidence: [
            {
              label: 'Rejalashtirilgan',
              value: this.hours(summary?.plannedMinutes),
            },
            { label: 'Norma', value: this.hours(summary?.targetMinutes) },
            { label: 'Versiya', value: String(plan.version) },
          ],
          action: {
            label: 'Post rejani ochish',
            href: this.postPlanHref(post, now, plan.id),
          },
        });
      } else if (pendingChanges) {
        items.push({
          id: `post-plan-change-${plan.id}`,
          level: 'WARNING',
          kind: 'PENDING_POST_CHANGE',
          unitName: post.name,
          departmentName: post.department.name,
          title: `${pendingChanges} ta grafik o‘zgarishi tasdiq kutmoqda`,
          description:
            'Tasdiqlangan bazaviy grafik o‘zgarmagan. So‘rovlar rahbar qaroridan keyin qo‘llanadi.',
          evidence: [
            { label: 'So‘rovlar', value: String(pendingChanges) },
            { label: 'Holat', value: 'Tasdiq kutilmoqda' },
            { label: 'Manba', value: 'Grafik o‘zgarishi' },
          ],
          action: {
            label: 'So‘rovlarni ko‘rish',
            href: this.postPlanHref(post, now, plan.id),
          },
        });
      } else {
        safe += 1;
      }
    }
    return this.modeResult(items, safe, posts.length);
  }

  private disabledPostMode(): ModeResult {
    return {
      enabled: false,
      disabledReason: 'Bu muassasada 24/7 post reja rejimi yoqilmagan.',
      metrics: { critical: 0, warning: 0, safe: 0, monitored: 0 },
      items: [],
    };
  }

  private async getFlexibleMode(
    hospitalId: string,
    now: dayjs.Dayjs,
  ): Promise<ModeResult> {
    const since = DateUtil.startOfDay(now.subtract(1, 'day').toDate());
    const activeAttendances = await this.prisma.attendanceRecord.findMany({
      where: {
        checkIn: { not: null },
        checkOut: null,
        expectedCheckOut: { gt: now.toDate() },
        workDate: { gte: since },
        employee: { hospitalId, firedAt: null },
      },
      include: {
        employee: {
          include: {
            department: true,
            position: true,
            user: {
              include: {
                liveLocations: { orderBy: { createdAt: 'desc' }, take: 1 },
              },
            },
          },
        },
      },
      orderBy: { checkIn: 'asc' },
    });

    const configured = Number(process.env.LIVE_LOCATION_STALE_MINUTES ?? 10);
    const staleMinutes = Number.isFinite(configured)
      ? Math.min(60, Math.max(3, configured))
      : 10;
    const items: OperationalRisk[] = [];
    let safe = 0;
    let monitored = 0;

    for (const attendance of activeAttendances) {
      const location = attendance.employee.user?.liveLocations?.[0];
      const expectsTracking =
        attendance.checkInSource === 'MOBILE' || !!location;
      if (!expectsTracking) continue;
      monitored += 1;

      if (!location) {
        items.push({
          id: `missing-location-${attendance.id}`,
          level: 'WARNING',
          kind: 'MISSING_LOCATION',
          unitName:
            attendance.employee.position?.name ??
            attendance.employee.department?.name ??
            'Xodim',
          departmentName: attendance.employee.department?.name ?? null,
          title: `${attendance.employee.fullName}dan GPS ma’lumoti kelmagan`,
          description:
            'Mobil check-in mavjud, ammo joriy ish sessiyasi uchun joylashuv signali olinmagan.',
          employeeId: attendance.employeeId,
          employeeName: attendance.employee.fullName,
          evidence: [
            {
              label: 'Check-in',
              value: dayjs(attendance.checkIn).tz(TZ).format('HH:mm'),
            },
            { label: 'Manba', value: attendance.checkInSource ?? 'MOBILE' },
            { label: 'Xulosa', value: 'Ketgan deb hisoblanmaydi' },
          ],
          action: {
            label: 'Live Xaritani ochish',
            href: '/dashboard/live-map',
          },
        });
        continue;
      }

      const ageMinutes = Math.max(
        0,
        now.diff(dayjs(location.createdAt), 'minute'),
      );
      if (ageMinutes > staleMinutes) {
        items.push({
          id: `stale-location-${attendance.id}`,
          level: 'WARNING',
          kind: 'STALE_LOCATION',
          unitName:
            attendance.employee.position?.name ??
            attendance.employee.department?.name ??
            'Xodim',
          departmentName: attendance.employee.department?.name ?? null,
          title: `${attendance.employee.fullName}dan yangi GPS signali kelmayapti`,
          description: `Oxirgi signal ${ageMinutes} daqiqa oldin kelgan. Bu holat xodim ketganini tasdiqlamaydi.`,
          employeeId: attendance.employeeId,
          employeeName: attendance.employee.fullName,
          evidence: [
            { label: 'Oxirgi signal', value: `${ageMinutes} daqiqa oldin` },
            {
              label: 'Check-in',
              value: dayjs(attendance.checkIn).tz(TZ).format('HH:mm'),
            },
            { label: 'Xulosa', value: 'Tekshiruv kerak' },
          ],
          action: {
            label: 'Live Xaritani ochish',
            href: '/dashboard/live-map',
          },
        });
      } else if (location.isOutside) {
        items.push({
          id: `outside-location-${attendance.id}`,
          level: 'WARNING',
          kind: 'OUTSIDE_GEOFENCE',
          unitName:
            attendance.employee.position?.name ??
            attendance.employee.department?.name ??
            'Xodim',
          departmentName: attendance.employee.department?.name ?? null,
          title: `${attendance.employee.fullName} ish hududidan tashqarida`,
          description:
            'Yangi GPS nuqtasi ruxsat etilgan ish joylari geofence hududidan tashqarida.',
          employeeId: attendance.employeeId,
          employeeName: attendance.employee.fullName,
          evidence: [
            { label: 'Yangilandi', value: `${ageMinutes} daqiqa oldin` },
            { label: 'Aniqlik', value: `±${Math.round(location.accuracy)} m` },
            { label: 'Manba', value: 'GPS + geofence' },
          ],
          action: {
            label: 'Live Xaritani ochish',
            href: '/dashboard/live-map',
          },
        });
      } else {
        safe += 1;
      }
    }
    return this.modeResult(items, safe, monitored);
  }

  private modeResult(
    items: OperationalRisk[],
    safe: number,
    monitored: number,
  ): ModeResult {
    return {
      enabled: true,
      metrics: {
        critical: items.filter((item) => item.level === 'CRITICAL').length,
        warning: items.filter((item) => item.level === 'WARNING').length,
        safe,
        monitored,
      },
      items: items
        .sort((a, b) => this.levelWeight(b.level) - this.levelWeight(a.level))
        .slice(0, 50),
    };
  }

  private levelWeight(level: RiskLevel) {
    return level === 'CRITICAL' ? 3 : level === 'WARNING' ? 2 : 1;
  }

  private hours(minutes: unknown) {
    const value = Number(minutes ?? 0) / 60;
    return `${Number.isInteger(value) ? value : value.toFixed(1)} soat`;
  }

  private postPlanHref(
    post: { id: string; departmentId: string },
    month: dayjs.Dayjs,
    planId?: string,
  ) {
    const query = new URLSearchParams({
      view: 'postlar',
      departmentId: post.departmentId,
      postId: post.id,
      year: String(month.year()),
      month: String(month.month() + 1),
    });
    if (planId) query.set('planId', planId);
    return `/dashboard/schedules?${query.toString()}`;
  }
}
