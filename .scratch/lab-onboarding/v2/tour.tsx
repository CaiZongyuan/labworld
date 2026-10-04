// PROTOTYPE: progressive guidance points at ordinary workspace controls.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { driver, type DriveStep, type Driver, type Side } from 'driver.js';
import 'driver.js/dist/driver.css';

type TourState = {
  status: 'active' | 'paused' | 'completed';
  index: number;
  review: boolean;
  labId: string;
  entityId: string;
};
const KEY = 'PROTOTYPE-lab-onboarding-v2-tour';
const initial = (): TourState => ({
  status: 'active',
  index: 0,
  review: false,
  labId: '',
  entityId: '',
});
function load(): TourState {
  try {
    const value = JSON.parse(
      localStorage.getItem(KEY) ?? 'null',
    ) as TourState | null;
    return value &&
      ['active', 'paused', 'completed'].includes(value.status) &&
      Number.isInteger(value.index) &&
      value.index >= 0 &&
      value.index < 14
      ? value
      : initial();
  } catch {
    return initial();
  }
}
let state = load();
const listeners = new Set<() => void>();
export const tourSnapshot = () => state;
export function useTour() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, tourSnapshot);
}
export function setTour(change: Partial<TourState>) {
  state = { ...state, ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
  listeners.forEach((listener) => listener());
}
export function resetTour() {
  state = initial();
  setTour({});
}
export const introSteps = [
  {
    target: 'create-lab',
    title: ['创建实验室', 'Create a laboratory'],
    body: [
      '从这里创建实验室。以后新建实验室，也使用这个入口。',
      'Create a laboratory here. This is also where you will create future labs.',
    ],
    side: 'bottom',
    action: true,
  },
  {
    target: 'create-form',
    title: ['名称与初始场景', 'Name and starting scene'],
    body: [
      '为实验室命名，再创建。基础实验台包含工作台、烧杯和传感器；随后我们亲手添加照明。',
      'Name your lab, then create it. The bench scene includes a bench, beaker and sensor. You will add a light next.',
    ],
    side: 'right',
    action: true,
  },
  {
    target: 'register',
    title: ['登记一个新对象', 'Register an object'],
    body: [
      '点击“登记对象”。设备、家具与器皿，都从这个入口加入当前实验室。',
      'Select Register object. Use this entry to add equipment, furniture and labware to the current lab.',
    ],
    side: 'bottom',
    action: true,
  },
  {
    target: 'register-form',
    title: ['选择定义，给对象命名', 'Choose a definition and a name'],
    body: [
      '这次选择照明，保留模拟来源，然后登记。定义可以复用，每次登记都有独立对象身份。',
      'Choose Light, keep the simulated source, and register it. A definition is reusable; every registration creates an independent object.',
    ],
    side: 'right',
    action: true,
  },
  {
    target: 'light-row',
    title: ['从目录选中对象', 'Select it in the directory'],
    body: [
      '点击刚加入的照明。以后可以从这里查找对象，也可以直接在三维场景中点选。',
      'Select the light you just added. Find objects here, or select them directly in the 3D scene.',
    ],
    side: 'right',
    action: true,
  },
  {
    target: 'edit-mode',
    title: ['切换到编辑布局', 'Switch to layout editing'],
    body: [
      '摆放对象前，先进入编辑布局。运行查看和编辑布局都在这里切换。',
      'Enter Edit layout before arranging objects. Switch between viewing and editing here.',
    ],
    side: 'bottom',
    action: true,
  },
  {
    target: 'placement',
    title: ['调整三维摆放', 'Adjust the placement'],
    body: [
      '修改一个坐标，然后继续到保存。以后也可在编辑模式下拖动对象；三维摆放不会自动改变登记位置。',
      'Change a coordinate, then continue to saving. You can also drag objects in edit mode later; visual placement does not change the registered location.',
    ],
    side: 'left',
    action: false,
  },
  {
    target: 'save',
    title: ['保存布局', 'Save the layout'],
    body: [
      '点击保存图标。看到“已保存”后，才完成这次布局修改。',
      'Select the save icon. The Saved status confirms that the layout change has been saved.',
    ],
    side: 'bottom',
    action: true,
  },
  {
    target: 'runtime-mode',
    title: ['回到运行查看', 'Return to View & run'],
    body: [
      '设备操作在运行查看中进行。下次摆放完成后，也从这里切回来。',
      'Operate devices in View & run. Return here after arranging your lab.',
    ],
    side: 'bottom',
    action: true,
  },
  {
    target: 'program',
    title: ['启动设备程序', 'Start the device program'],
    body: [
      '点击启动程序。照明的模拟状态由设备程序产生，放入模型不会自动启动设备。',
      'Start the program. It produces the simulated light state; placing a model does not start a device.',
    ],
    side: 'left',
    action: true,
  },
  {
    target: 'light-controls',
    title: ['点亮照明', 'Switch on the light'],
    body: [
      '打开电源，或调节亮度后点击应用。以后这台设备的控制都在右侧对象信息里。',
      'Switch on the light, or adjust brightness and apply it. Find this device’s controls in its inspector.',
    ],
    side: 'left',
    action: true,
  },
  {
    target: 'light-reading',
    title: ['确认设备实际报告', 'Check the reported state'],
    body: [
      '这里是设备观测：开启状态、亮度与报告时间。用它确认操作是否生效，模拟来源始终可辨。',
      'This is the device observation: power, brightness and report time. Use it to confirm an action, with the simulated source clearly identified.',
    ],
    side: 'left',
    action: false,
  },
  {
    target: 'assets',
    title: ['可复用资产在这里', 'Reusable assets live here'],
    body: [
      '资产库保存可复用的对象定义和模型。点击打开资产库；以后添加对象仍使用“登记对象”。',
      'The asset library contains reusable definitions and models. Open it here; use Register object to add instances to your lab.',
    ],
    side: 'bottom',
    action: true,
  },
  {
    target: 'help',
    title: ['需要时再看一次', 'Return whenever you need'],
    body: [
      '引导结束后，这些按钮都留在原来的位置。点击问号，可以继续未完成的引导或重新查看操作位置。',
      'The controls stay in these locations after the tour. Use the question mark to resume a paused tour or review the workspace.',
    ],
    side: 'bottom',
    action: false,
  },
] as const;
export const reviewSteps = [
  introSteps[0],
  introSteps[2],
  {
    target: 'directory',
    title: ['对象目录', 'Entity directory'],
    body: [
      '在这里搜索和选择对象。选中对象后，右侧显示它的属性与控制。',
      'Search and select objects here. The inspector shows the selected object’s properties and controls.',
    ],
    side: 'right',
    action: false,
  },
  introSteps[5],
  introSteps[6],
  introSteps[7],
  introSteps[8],
  { ...introSteps[9], target: 'program-section' },
  introSteps[10],
  introSteps[11],
  {
    target: 'history',
    title: ['查看操作记录', 'Review activity'],
    body: [
      '这里保留操作与观测的记录。选中设备后，可核对刚才的操作结果。',
      'Review actions and observations here, and check the result of a device operation.',
    ],
    side: 'top',
    action: false,
  },
  introSteps[12],
  introSteps[13],
] as const;

export function VisualTour({
  locale,
  canNext,
  onNext,
  onPause,
}: {
  locale: string;
  canNext: boolean;
  onNext: () => void;
  onPause: () => void;
}) {
  const tour = useTour();
  const instance = useRef<Driver | null>(null);
  const callbacks = useRef({ onNext, onPause });
  callbacks.current = { onNext, onPause };
  const steps = tour.review ? reviewSteps : introSteps;
  useEffect(() => {
    const t = (values: readonly [string, string]) =>
      values[locale === 'zh' ? 0 : 1];
    const driveSteps: DriveStep[] = steps.map((step, index) => ({
      element: `[data-tour="${step.target}"]`,
      waitForElement: 2500,
      popover: {
        title: t(step.title),
        description: t(step.body),
        side: step.side as Side,
        align: 'center',
        showButtons: tour.review
          ? index
            ? ['previous', 'close', 'next']
            : ['close', 'next']
          : step.action
            ? ['close']
            : ['close', 'next'],
        nextBtnText:
          index === steps.length - 1
            ? t(['完成引导', 'Finish tour'])
            : step.target === 'placement' && !tour.review
              ? t(['继续到保存', 'Continue to saving'])
              : t(['下一步', 'Next']),
        doneBtnText: t(['完成引导', 'Finish tour']),
        prevBtnText: t(['上一步', 'Back']),
        onPrevClick: () => {
          const current = tourSnapshot();
          if (current.review && current.index > 0)
            setTour({ index: current.index - 1 });
        },
        onNextClick: () => callbacks.current.onNext(),
        onDoneClick: () => callbacks.current.onNext(),
        onCloseClick: () => callbacks.current.onPause(),
        onPopoverRender: (popover) => {
          popover.wrapper.dataset.tourIndex = String(index);
          popover.wrapper.dataset.tourTarget = step.target;
          popover.wrapper.style.setProperty(
            '--tour-progress',
            `${((index + 1) / steps.length) * 100}%`,
          );
          popover.wrapper.setAttribute(
            'aria-label',
            t(['新手引导', 'First-use tour']),
          );
          const kicker = document.createElement('div');
          kicker.className = 'tour-kicker';
          kicker.textContent = `${tour.review ? t(['操作位置回顾', 'Workspace review']) : t(['首次使用', 'First use'])} · ${index + 1} / ${steps.length}`;
          popover.wrapper.insertBefore(kicker, popover.title);
          popover.closeButton.textContent = t(['跳过', 'Skip']);
          popover.closeButton.setAttribute(
            'aria-label',
            t(['跳过引导', 'Skip tour']),
          );
          popover.closeButton.title = t(['跳过引导', 'Skip tour']);
          popover.progress.textContent =
            step.action && !tour.review
              ? t(['直接操作高亮控件', 'Use the highlighted control'])
              : t(['随时可以跳过', 'You can skip at any time']);
          popover.progress.style.display = 'block';
          popover.footer.style.display = 'flex';
          popover.footerButtons.style.display =
            step.action && !tour.review ? 'none' : 'flex';
          popover.previousButton.style.display =
            tour.review && index > 0 ? 'block' : 'none';
          popover.nextButton.style.display =
            step.action && !tour.review ? 'none' : 'block';
        },
      },
    }));
    const active = driver({
      animate: false,
      overlayColor: '#151919',
      overlayOpacity: 0.48,
      stagePadding: 6,
      stageRadius: 6,
      popoverOffset: 12,
      popoverClass: 'lab-tour',
      allowClose: true,
      allowScroll: true,
      overlayClickBehavior: 'none',
      disableActiveInteraction: tour.review,
      showProgress: false,
      allowKeyboardControl: true,
      closeBtnLabel: t(['跳过引导', 'Skip tour']),
      onDestroyed: () => callbacks.current.onPause(),
      steps: driveSteps,
    });
    instance.current = active;
    return () => {
      active.setConfig({ ...active.getConfig(), onDestroyed: undefined });
      active.destroy();
      instance.current = null;
    };
  }, [locale, tour.review]);
  useEffect(() => {
    const active = instance.current;
    if (!active) return;
    if (tour.status !== 'active') {
      active.setConfig({ ...active.getConfig(), onDestroyed: undefined });
      active.destroy();
      return;
    }
    active.setConfig({
      ...active.getConfig(),
      onDestroyed: () => callbacks.current.onPause(),
    });
    active.drive(tour.index);
    const observer = new ResizeObserver(() => active.refresh());
    const observe = () => {
      const target = active.getActiveElement();
      if (target) observer.observe(target);
    };
    const frame = requestAnimationFrame(observe);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [locale, tour.review, tour.status, tour.index]);
  useEffect(() => {
    const active = instance.current;
    if (!active || tour.status !== 'active') return;
    active.setConfig({
      ...active.getConfig(),
      disableButtons: canNext ? [] : ['next'],
    });
    const popover = active.getState('popover');
    if (popover) popover.nextButton.disabled = !canNext;
  }, [canNext, tour.index, tour.status, locale, tour.review]);
  return null;
}
