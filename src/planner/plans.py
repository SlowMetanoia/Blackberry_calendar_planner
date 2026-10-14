import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    ActionPlan,
    ActionStatus,
    PlanStatus,
    PlannedAction,
    User,
)
from .config import get_settings
from .schemas import DecisionAction
from .services import EventService, TaskService

ACTIVE_ACTIONS = {ActionStatus.pending, ActionStatus.approved, ActionStatus.executing}


class PlanService:
    @staticmethod
    async def create(
        session: AsyncSession,
        *,
        owner_id: uuid.UUID,
        conversation_id: uuid.UUID,
        source_message_id: uuid.UUID,
        mutations: list[DecisionAction],
    ) -> ActionPlan:
        has_update_or_delete = any(item.operation != "create" for item in mutations)
        timeout = get_settings().create_auto_confirm_seconds
        expires_at = None if has_update_or_delete else datetime.now(timezone.utc) + timedelta(seconds=timeout)
        plan = ActionPlan(
            owner_id=owner_id,
            conversation_id=conversation_id,
            source_message_id=source_message_id,
            expires_at=expires_at,
        )
        session.add(plan)
        await session.flush()
        for ordinal, item in enumerate(mutations):
            session.add(
                PlannedAction(
                    plan_id=plan.id,
                    ordinal=ordinal,
                    operation=item.operation,
                    resource=item.resource,
                    target_id=item.target_id,
                    payload=item.payload.model_dump(mode="json", exclude_none=True),
                    expires_at=expires_at,
                )
            )
        await session.flush()
        return plan

    @staticmethod
    async def get_owned(session: AsyncSession, plan_id: uuid.UUID, owner_id: uuid.UUID):
        return await session.scalar(
            select(ActionPlan).where(ActionPlan.id == plan_id, ActionPlan.owner_id == owner_id)
        )

    @staticmethod
    async def actions(session: AsyncSession, plan_id: uuid.UUID):
        query = select(PlannedAction).where(PlannedAction.plan_id == plan_id).order_by(
            PlannedAction.ordinal
        )
        return list((await session.scalars(query)).all())

    @staticmethod
    async def approve_action(session: AsyncSession, plan: ActionPlan, action_id: uuid.UUID):
        action = await session.scalar(
            select(PlannedAction)
            .where(PlannedAction.id == action_id, PlannedAction.plan_id == plan.id)
            .with_for_update()
        )
        if action is None:
            return None, False
        if action.status == ActionStatus.pending:
            action.status = ActionStatus.approved
            await PlanService.recompute(session, plan)
            await session.commit()
            return action, True
        return action, False

    @staticmethod
    async def approve_all(session: AsyncSession, plan: ActionPlan):
        query = (
            select(PlannedAction)
            .where(PlannedAction.plan_id == plan.id)
            .order_by(PlannedAction.ordinal)
            .with_for_update()
        )
        actions = list((await session.scalars(query)).all())
        queueable = []
        for action in actions:
            if action.status == ActionStatus.pending:
                action.status = ActionStatus.approved
            if action.status == ActionStatus.approved:
                queueable.append(action.id)
        await PlanService.recompute(session, plan)
        await session.commit()
        return queueable

    @staticmethod
    async def cancel_pending(session: AsyncSession, plan: ActionPlan):
        actions = await PlanService.actions(session, plan.id)
        for action in actions:
            if action.status == ActionStatus.pending:
                action.status = ActionStatus.cancelled
        await PlanService.recompute(session, plan)
        await session.commit()

    @staticmethod
    async def recompute(session: AsyncSession, plan: ActionPlan):
        actions = await PlanService.actions(session, plan.id)
        statuses = {action.status for action in actions}
        if ActionStatus.executing in statuses:
            plan.status = PlanStatus.executing
        elif ActionStatus.approved in statuses:
            plan.status = PlanStatus.partially_confirmed
        elif ActionStatus.pending in statuses:
            plan.status = (
                PlanStatus.partially_confirmed
                if statuses - {ActionStatus.pending}
                else PlanStatus.pending
            )
        elif ActionStatus.failed in statuses:
            plan.status = PlanStatus.failed
        elif statuses and statuses <= {ActionStatus.cancelled, ActionStatus.rejected}:
            plan.status = PlanStatus.cancelled
        else:
            plan.status = PlanStatus.completed

    @staticmethod
    async def execute_action(session: AsyncSession, action_id: uuid.UUID) -> ActionStatus | None:
        action = await session.scalar(
            select(PlannedAction).where(PlannedAction.id == action_id).with_for_update()
        )
        if action is None or action.status != ActionStatus.approved:
            return None if action is None else action.status
        plan = await session.get(ActionPlan, action.plan_id)
        user = await session.get(User, plan.owner_id) if plan else None
        if plan is None or user is None:
            return None
        action.status = ActionStatus.executing
        await PlanService.recompute(session, plan)
        await session.commit()

        operation, resource, target_id, payload = (
            action.operation,
            action.resource,
            action.target_id,
            action.payload,
        )
        try:
            service = TaskService if resource == "task" else EventService
            if operation == "create":
                result = await service.create(session, user, payload)
                action_result = {"id": str(result.id)}
            elif operation == "update":
                result = await service.update(session, user, target_id, payload)
                if result is None:
                    raise ValueError("Target not found")
                action_result = {"id": str(result.id)}
            else:
                if not await service.delete(session, user, target_id):
                    raise ValueError("Target not found")
                action_result = {"deleted": str(target_id)}
            action = await session.get(PlannedAction, action_id)
            action.result = action_result
            action.status = ActionStatus.completed
        except Exception as exc:
            await session.rollback()
            action = await session.get(PlannedAction, action_id)
            action.status = ActionStatus.failed
            action.error = str(exc)[:1000]
        plan = await session.get(ActionPlan, action.plan_id)
        await PlanService.recompute(session, plan)
        await session.commit()
        return action.status
